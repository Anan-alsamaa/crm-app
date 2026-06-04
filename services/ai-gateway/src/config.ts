import { parseEnv, numericEnv } from '@yiji/shared-config';
import { z } from 'zod';

const schema = z.object({
  PORT: numericEnv(8081),
  DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
  DIRECTUS_AI_TOKEN: z.string().default(''),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SVC_AI_TOKEN: z.string().min(1, 'SVC_AI_TOKEN is required'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
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
});

export type AiGatewayConfig = z.infer<typeof schema>;

export function loadConfig(): AiGatewayConfig {
  return parseEnv(schema);
}
