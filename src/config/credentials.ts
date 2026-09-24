import { z } from 'zod';

import { validateEnv } from './validate.js';

export interface BoardCredential {
  readonly ref: string;
  readonly apiKey: string;
  readonly token: string;
  /**
   * The OAuth/API secret that belongs to the API key — neither the key nor the
   * token. Only webhook signature verification needs it, so it stays optional
   * here and is demanded, by name, at registration time.
   */
  readonly apiSecret: string | undefined;
}

const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]*$/;

/**
 * Resolve every credential ref named in the config against the environment.
 *
 * `board.credentials: TRELLO_MAIN` requires `TRELLO_MAIN_API_KEY` and
 * `TRELLO_MAIN_TOKEN`, and optionally `TRELLO_MAIN_API_SECRET` for webhooks.
 * Building the schema from the refs means the error names exactly which
 * project's credential is missing, at boot.
 */
export function resolveBoardCredentials(
  refs: ReadonlyMap<string, readonly string[]>, // ref -> project ids using it
  source: unknown = process.env,
): ReadonlyMap<string, BoardCredential> {
  const shape: Record<string, z.ZodType> = {};
  for (const ref of refs.keys()) {
    if (!CREDENTIAL_REF.test(ref)) {
      throw new Error(`Invalid credential ref "${ref}" — use UPPER_SNAKE_CASE`);
    }
    const users = refs.get(ref)?.join(', ') ?? '';
    const message = `missing — required by project(s): ${users}`;
    shape[`${ref}_API_KEY`] = z.string({ error: message }).min(1, message);
    shape[`${ref}_TOKEN`] = z.string({ error: message }).min(1, message);
    // Optional: projects without webhooks must keep loading on an old .env.
    shape[`${ref}_API_SECRET`] = z
      .string()
      .optional()
      .transform((v) => (v === '' ? undefined : v));
  }

  const env = validateEnv('board credentials', z.object(shape), source) as Record<
    string,
    string | undefined
  >;

  const out = new Map<string, BoardCredential>();
  for (const ref of refs.keys()) {
    out.set(ref, {
      ref,
      apiKey: env[`${ref}_API_KEY`] as string,
      token: env[`${ref}_TOKEN`] as string,
      apiSecret: env[`${ref}_API_SECRET`],
    });
  }
  return out;
}
