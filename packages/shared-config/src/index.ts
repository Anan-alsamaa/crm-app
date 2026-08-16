/**
 * @yiji/shared-config — shared configuration helpers.
 *
 * - env.ts: Zod-based env parsing/validation (this phase, T005)
 * - directus-client.ts: typed service-account Directus REST client (Phase 2, T023)
 * - auth.ts: Directus auth client for portals (Phase 3, T030)
 */

export { parseEnv, numericEnv, booleanEnv, redisUrlSchema } from './env.js';
/* Zod-free browser helpers — see runtime.ts for why they are not in env.ts. */
export { onPageHost, exportFileName } from './runtime.js';
export {
  createServiceClient,
  type YijiDirectusClient,
  type DirectusClientOptions,
} from './directus-client.js';
export {
  createAuthClient,
  browserAuthStorage,
  type AuthClient,
  type AuthUser,
  type AuthClientOptions,
} from './auth.js';

/* NOTE: ./redis is deliberately NOT re-exported here. It imports ioredis,
 * which is Node-only, and the browser portals import this package for auth —
 * re-exporting it pulled ioredis into the portal bundle and the app rendered
 * a blank page at runtime while the build still passed. Server code imports
 * it explicitly:  import { createRedis } from '@yiji/shared-config/redis'  */
