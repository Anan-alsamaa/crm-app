import { z } from 'zod';

/**
 * Parse and validate environment variables against a Zod schema.
 * Throws a readable aggregated error if any required var is missing/invalid,
 * so services fail fast at boot rather than at first use.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/** Coerce a string env var to a number with a default. */
export const numericEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

/** Coerce common truthy strings ("1","true","yes") to boolean. */
export const booleanEnv = (def = false) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

/** Shared Redis URL schema (used by gateway, workers, ai-gateway). */
export const redisUrlSchema = z.string().url().default('redis://localhost:6379');
