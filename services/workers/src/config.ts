import { parseEnv, numericEnv } from '@yiji/shared-config';
import { z } from 'zod';

/** A value that is still the `.env.example` placeholder is treated as "unset". */
const isPlaceholder = (v: string): boolean => /^replace-with/i.test(v.trim());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    SVC_WORKERS_TOKEN: z.string().min(1, 'SVC_WORKERS_TOKEN is required'),
    SVC_AI_TOKEN: z.string().optional().default(''),
    AI_GATEWAY_URL: z.string().url().default('http://localhost:8081'),
    /** Identity the worker presents to the gateway for rate-limit scoping. */
    AI_WORKER_USER_ID: z.string().default('svc:workers'),
    HEALTH_PORT: numericEnv(8090),
    LOG_LEVEL: z.string().default('info'),
    // SMTP (MailTransport). When SMTP_HOST is empty the dev no-op transport is used.
    SMTP_HOST: z.string().optional().default(''),
    SMTP_PORT: numericEnv(587),
    SMTP_USER: z.string().optional().default(''),
    SMTP_PASSWORD: z.string().optional().default(''),
    SMTP_FROM: z.string().optional().default('Yiji Support <support@example.com>'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    if (isPlaceholder(cfg.SVC_WORKERS_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SVC_WORKERS_TOKEN'],
        message:
          'must be a real Directus service token (not the .env.example placeholder) in production',
      });
    }
    if (!cfg.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message:
          'must be set in production — without it notifications + scheduled reports silently no-op',
      });
    }
  });

export type WorkersConfig = z.infer<typeof schema>;

export function loadConfig(): WorkersConfig {
  return parseEnv(schema);
}
