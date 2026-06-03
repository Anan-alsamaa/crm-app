import {
  createDirectus,
  rest,
  staticToken,
  type DirectusClient,
  type RestClient,
  type StaticTokenClient,
} from '@directus/sdk';

/**
 * Typed Directus REST client for the Node services (socket-gateway, workers,
 * ai-gateway). Authenticates with a service-account static token loaded from
 * the environment — tokens are never hard-coded (FR per spec Section 14).
 */

// Untyped schema (collections resolved at call sites) so service code can read
// any collection by name. A fully-typed schema can replace `any` later.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;
export type YijiDirectusClient = DirectusClient<AnySchema> &
  RestClient<AnySchema> &
  StaticTokenClient<AnySchema>;

export interface DirectusClientOptions {
  /** Base URL of the Directus instance (internal URL inside docker network). */
  url: string;
  /** Service-account static token. */
  token: string;
}

/** Create a service-account Directus client. Throws if url/token missing. */
export function createServiceClient(opts: DirectusClientOptions): YijiDirectusClient {
  if (!opts.url) throw new Error('Directus client: url is required');
  if (!opts.token) throw new Error('Directus client: service-account token is required');
  return createDirectus(opts.url).with(staticToken(opts.token)).with(rest());
}
