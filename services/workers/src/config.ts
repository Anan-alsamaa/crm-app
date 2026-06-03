import { parseEnv, numericEnv } from '@yiji/shared-config';
import { z } from 'zod';

const schema = z.object({
  DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SVC_WORKERS_TOKEN: z.string().min(1, 'SVC_WORKERS_TOKEN is required'),
  AI_GATEWAY_URL: z.string().url().default('http://localhost:8081'),
  HEALTH_PORT: numericEnv(8090),
  LOG_LEVEL: z.string().default('info'),
  // SMTP (MailTransport). When SMTP_HOST is empty the dev no-op transport is used.
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: numericEnv(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default('Yiji Support <support@example.com>'),
});

export type WorkersConfig = z.infer<typeof schema>;

export function loadConfig(): WorkersConfig {
  return parseEnv(schema);
}
