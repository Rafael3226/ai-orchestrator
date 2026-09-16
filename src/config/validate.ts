import { z } from 'zod';

/**
 * Validate a source object against a schema, failing fast on boot.
 *
 * On success returns a typed, frozen object so consumers never read raw input
 * and cannot mutate config at runtime. On failure prints a readable list of
 * problems and throws, so a misconfiguration surfaces at startup rather than
 * as `undefined` deep inside a run.
 */
export function validateEnv<T extends z.ZodType>(
  label: string,
  schema: T,
  source: unknown,
): Readonly<z.infer<T>> {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    console.error(`❌ Invalid ${label}:\n` + z.prettifyError(parsed.error));
    throw new Error(`Invalid ${label}. See the errors above.`);
  }

  return Object.freeze(parsed.data);
}
