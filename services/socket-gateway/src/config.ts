import { parseEnv, numericEnv, booleanEnv } from '@yiji/shared-config';
import { z } from 'zod';

/** A value that is still the `.env.example` placeholder is treated as "unset". */
const isPlaceholder = (v: string): boolean => /^replace-with/i.test(v.trim());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: numericEnv(8080),
    DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    // When false, run a single in-memory instance: no Socket.IO Redis adapter and
    // no BullMQ side-effect jobs. Lets the gateway run locally without Redis.
    // Production refuses REDIS_ENABLED=false (would silently disable scaling +
    // cross-instance fanout + side-effect jobs).
    REDIS_ENABLED: booleanEnv(true),
    YIJI_JWT_SECRET: z.string().min(1, 'YIJI_JWT_SECRET is required'),
    SVC_GATEWAY_TOKEN: z.string().min(1, 'SVC_GATEWAY_TOKEN is required'),
    // CORS allow-list — comma-separated exact origins or `*` (dev only).
    // Production refuses `*`.
    CORS_ORIGIN: z.string().default('*'),
    LOG_LEVEL: z.string().default('info'),
    // Inbound webhook HMAC secret. When empty, POST /webhooks/yiji returns 503
    // (not configured) so the endpoint is never an unauthenticated open door.
    YIJI_WEBHOOK_SECRET: z.string().default(''),
    // Replay-protection window for webhook timestamps (seconds).
    WEBHOOK_TOLERANCE_SEC: numericEnv(300),
    // Attachment validation: max size + allowed MIME types (comma-separated).
    ATTACHMENT_MAX_BYTES: numericEnv(10 * 1024 * 1024),
    ATTACHMENT_ALLOWED_MIME: z
      .string()
      .default('image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain'),
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
    if (!cfg.REDIS_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_ENABLED'],
        message: 'must be true in production (in-memory mode disables scaling + side-effects)',
      });
    }
    if (isPlaceholder(cfg.YIJI_JWT_SECRET) || cfg.YIJI_JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YIJI_JWT_SECRET'],
        message:
          'must be a strong secret (>=32 chars, not the .env.example placeholder) in production',
      });
    }
    if (isPlaceholder(cfg.SVC_GATEWAY_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SVC_GATEWAY_TOKEN'],
        message:
          'must be a real Directus service token (not the .env.example placeholder) in production',
      });
    }
  });

export type GatewayConfig = z.infer<typeof schema>;

export function loadConfig(): GatewayConfig {
  return parseEnv(schema);
}
