import { z } from 'zod';

import type { BoardProvider } from './config.schema.js';
import { validateEnv } from './validate.js';

export interface TrelloCredential {
  readonly kind: 'trello';
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

export interface AzureDevOpsCredential {
  readonly kind: 'azure-devops';
  readonly ref: string;
  /** Personal access token: Work Items (read & write) and Code (read & write). */
  readonly pat: string;
}

export interface JiraCredential {
  readonly kind: 'jira';
  readonly ref: string;
  readonly email: string;
  readonly apiToken: string;
}

export type BoardCredential = TrelloCredential | AzureDevOpsCredential | JiraCredential;
export type CredentialKind = BoardCredential['kind'];

/** Who uses a credential ref: its provider, and the projects that name it. */
export interface CredentialUse {
  readonly kind: CredentialKind;
  readonly projects: readonly string[];
}

const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]*$/;

/** The env var suffixes each provider needs; the optional ones may be absent. */
const REQUIRED: Record<BoardProvider, readonly string[]> = {
  trello: ['API_KEY', 'TOKEN'],
  'azure-devops': ['PAT'],
  jira: ['EMAIL', 'API_TOKEN'],
};

/**
 * Resolve every credential ref named in the config against the environment.
 *
 * - Trello, `credentials: TRELLO_MAIN`: `TRELLO_MAIN_API_KEY`, `TRELLO_MAIN_TOKEN`,
 *   and optionally `TRELLO_MAIN_API_SECRET` for webhooks.
 * - Azure DevOps, `ADO_MAIN`: `ADO_MAIN_PAT`.
 * - Jira, `JIRA_MAIN`: `JIRA_MAIN_EMAIL`, `JIRA_MAIN_API_TOKEN`.
 *
 * Building the schema from the refs means the error names exactly which
 * project's credential is missing, at boot.
 */
export function resolveBoardCredentials(
  refs: ReadonlyMap<string, CredentialUse>,
  source: unknown = process.env,
): ReadonlyMap<string, BoardCredential> {
  const shape: Record<string, z.ZodType> = {};
  for (const [ref, use] of refs) {
    if (!CREDENTIAL_REF.test(ref)) {
      throw new Error(`Invalid credential ref "${ref}" — use UPPER_SNAKE_CASE`);
    }
    const message = `missing — required by project(s): ${use.projects.join(', ')}`;
    for (const suffix of REQUIRED[use.kind]) {
      shape[`${ref}_${suffix}`] = z.string({ error: message }).min(1, message);
    }
    if (use.kind === 'trello') {
      // Optional: projects without webhooks must keep loading on an old .env.
      shape[`${ref}_API_SECRET`] = z
        .string()
        .optional()
        .transform((v) => (v === '' ? undefined : v));
    }
  }

  const env = validateEnv('board credentials', z.object(shape), source) as Record<
    string,
    string | undefined
  >;
  const read = (name: string): string => env[name] as string;

  const out = new Map<string, BoardCredential>();
  for (const [ref, use] of refs) {
    switch (use.kind) {
      case 'trello':
        out.set(ref, {
          kind: 'trello',
          ref,
          apiKey: read(`${ref}_API_KEY`),
          token: read(`${ref}_TOKEN`),
          apiSecret: env[`${ref}_API_SECRET`],
        });
        break;
      case 'azure-devops':
        out.set(ref, { kind: 'azure-devops', ref, pat: read(`${ref}_PAT`) });
        break;
      case 'jira':
        out.set(ref, {
          kind: 'jira',
          ref,
          email: read(`${ref}_EMAIL`),
          apiToken: read(`${ref}_API_TOKEN`),
        });
        break;
    }
  }
  return out;
}

/** Narrow a resolved credential to the provider that needs it. */
export function credentialOf<K extends CredentialKind>(
  cred: BoardCredential | undefined,
  kind: K,
  ref: string,
): Extract<BoardCredential, { kind: K }> {
  if (!cred) throw new Error(`credential ref ${ref} is unresolved`);
  if (cred.kind !== kind) {
    throw new Error(`credential ref ${ref} is a ${cred.kind} credential, but ${kind} needs it`);
  }
  return cred as Extract<BoardCredential, { kind: K }>;
}
