import { parseEnv, numericEnv, booleanEnv } from '@yiji/shared-config';
import { z } from 'zod';

const schema = z.object({
  PORT: numericEnv(8080),
  DIRECTUS_INTERNAL_URL: z.string().url().default('http://localhost:8055'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // When false, run a single in-memory instance: no Socket.IO Redis adapter and
  // no BullMQ side-effect jobs. Lets the gateway run locally without Redis.
  REDIS_ENABLED: booleanEnv(true),
  YIJI_JWT_SECRET: z.string().min(1, 'YIJI_JWT_SECRET is required'),
  SVC_GATEWAY_TOKEN: z.string().min(1, 'SVC_GATEWAY_TOKEN is required'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
});

export type GatewayConfig = z.infer<typeof schema>;

export function loadConfig(): GatewayConfig {
  return parseEnv(schema);
}
