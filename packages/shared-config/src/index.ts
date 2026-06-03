/**
 * @yiji/shared-config — shared configuration helpers.
 *
 * - env.ts: Zod-based env parsing/validation (this phase, T005)
 * - directus-client.ts: typed service-account Directus REST client (Phase 2, T023)
 * - auth.ts: Directus auth client for portals (Phase 3, T030)
 */

export { parseEnv, numericEnv, booleanEnv, redisUrlSchema } from './env.js';
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
