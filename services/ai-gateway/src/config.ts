import { parseEnv, numericEnv } from '@yiji/shared-config';
import { z } from 'zod';

/** A value that is still the `.env.example` placeholder is treated as "unset". */
const isPlaceholder = (v: string): boolean => /^replace-with/i.test(v.trim());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: numericEnv(8081),
    DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
    DIRECTUS_AI_TOKEN: z.string().default(''),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    SVC_AI_TOKEN: z.string().min(1, 'SVC_AI_TOKEN is required'),
    GEMINI_API_KEY: z.string().optional().default(''),
    GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
    /**
     * Yiji commerce API — proxied server-side so the API key never reaches the
     * browser (replaces the old VITE_YIJI_API_TOKEN). Empty URL => mock client.
     */
    YIJI_API_URL: z.string().default(''),
    YIJI_API_KEY: z.string().default(''),
    /** Per-user requests per minute. */
    AI_PER_USER_RPM: numericEnv(20),
    /** Per-IP requests per minute (anti-abuse layer in front of per-user). */
    AI_PER_IP_RPM: numericEnv(60),
    /** Global requests per minute. */
    AI_GLOBAL_RPM: numericEnv(120),
    /** Cache TTL in seconds. */
    AI_CACHE_TTL_SEC: numericEnv(900),
    /**
     * CORS origin allow-list. Comma-separated exact origins or `*` (dev only).
     * Default is `*` for local dev; production MUST set this to the portal
     * hostnames (e.g. https://agent.example.com,https://admin.example.com).
     */
    CORS_ORIGIN: z.string().default('*'),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    if (cfg.CORS_ORIGIN.trim() === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'must be an explicit origin allow-list in production (not "*")',
      });
    }
    if (isPlaceholder(cfg.SVC_AI_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SVC_AI_TOKEN'],
        message: 'must be a real service token (not the .env.example placeholder) in production',
      });
    }
    // GEMINI_API_KEY is intentionally NOT required: the service degrades
    // gracefully (AI endpoints return 503 `not_configured`). index.ts logs a
    // loud warning at boot when it is absent, so the degrade is not silent.
  });

export type AiGatewayConfig = z.infer<typeof schema>;

export function loadConfig(): AiGatewayConfig {
  return parseEnv(schema);
}
