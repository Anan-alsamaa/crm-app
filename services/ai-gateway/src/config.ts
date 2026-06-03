import { parseEnv, numericEnv } from '@yiji/shared-config';
import { z } from 'zod';

const schema = z.object({
  PORT: numericEnv(8081),
  DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SVC_AI_TOKEN: z.string().min(1, 'SVC_AI_TOKEN is required'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  LOG_LEVEL: z.string().default('info'),
});

export type AiGatewayConfig = z.infer<typeof schema>;

export function loadConfig(): AiGatewayConfig {
  return parseEnv(schema);
}
