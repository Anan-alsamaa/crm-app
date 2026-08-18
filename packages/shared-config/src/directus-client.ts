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

/**
 * Every request gets a deadline. Without one, a stale keep-alive socket (e.g.
 * after a Directus restart, or an idle connection the server closed) made the
 * SDK's fetch hang indefinitely — and in the socket-gateway that hang sits
 * inside the connection middleware, so a customer stared at "Connecting…"
 * forever with nothing in any log.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A failure of the CONNECTION, not the request: the socket died before a
 * response existed (undici's UND_ERR_SOCKET / ECONNRESET / EPIPE family, or
 * our own deadline). These are worth one immediate retry on a fresh socket —
 * the classic case is the first request after Directus restarted, which used
 * to fail with "other side closed" and take a whole feature down with it.
 */
function isTransportError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true;
  }
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? '';
  return (
    code.startsWith('UND_ERR') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  );
}

/**
 * Create a service-account Directus client. Throws if url/token missing.
 *
 * Requests carry a 15s deadline and retry ONCE on a transport-level failure —
 * see the notes above. Application errors (4xx/5xx bodies) are never retried.
 */
export function createServiceClient(opts: DirectusClientOptions): YijiDirectusClient {
  if (!opts.url) throw new Error('Directus client: url is required');
  if (!opts.token) throw new Error('Directus client: service-account token is required');
  const client = createDirectus(opts.url)
    .with(staticToken(opts.token))
    .with(
      rest({
        onRequest: (options) => ({ ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      }),
    );
  const original = client.request.bind(client);
  client.request = (async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (err) {
      if (!isTransportError(err)) throw err;
      return original(...args);
    }
  }) as typeof client.request;
  return client;
}
