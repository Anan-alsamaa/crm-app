/**
 * THE READ-ONLY GUARD — the one place this server decides what may leave it.
 *
 * Every HTTP request the tools make goes through `readOnlyFetch`, and nothing
 * else in this package calls `fetch` against the CRM. The rule is deliberately
 * small enough to read in one breath:
 *
 *   - the request must go to the production API origin, and nowhere else;
 *   - GET is allowed on any path;
 *   - POST is allowed on exactly two paths, the session ones:
 *     `/auth/login` and `/auth/refresh`;
 *   - everything else (PATCH, PUT, DELETE, any other POST, ...) THROWS before
 *     a byte is sent.
 *
 * The guard runs before the network call, so a bug elsewhere in the server
 * cannot turn into a write on production: it turns into an exception.
 */

export const API_HOST = 'crm-api.anan.sa';
export const API_ORIGIN = `https://${API_HOST}`;

/** The only non-GET requests that may be sent: opening and renewing the session. */
const SESSION_POSTS: ReadonlySet<string> = new Set(['/auth/login', '/auth/refresh']);

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}

/**
 * Throw unless `method url` is a request this read-only server may send.
 * Returns the resolved URL so the caller sends exactly what was checked.
 */
export function assertReadOnly(method: string, url: string | URL): URL {
  const verb = method.toUpperCase();
  let u: URL;
  try {
    u = new URL(url, API_ORIGIN);
  } catch {
    throw new ReadOnlyViolation(`Refused: not a valid URL`);
  }
  if (u.origin !== API_ORIGIN) {
    throw new ReadOnlyViolation(`Refused: requests may only go to ${API_ORIGIN}`);
  }
  if (verb === 'GET') return u;
  // Normalise a trailing slash so `/auth/login/` cannot slip past or be refused oddly.
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (verb === 'POST' && SESSION_POSTS.has(path)) return u;
  throw new ReadOnlyViolation(
    `Refused: this server is READ-ONLY (${verb} ${path} is not allowed; only GET, plus POST /auth/login and /auth/refresh)`,
  );
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * The single gateway to the network. `init.method` is ignored in favour of the
 * explicit `method` argument, so the verb that was checked is the verb sent.
 */
export async function readOnlyFetch(
  method: string,
  url: string | URL,
  init: Omit<RequestInit, 'method'> = {},
  fetchImpl: FetchLike = (input, i) => fetch(input, i),
): Promise<Response> {
  const checked = assertReadOnly(method, url);
  return fetchImpl(checked, { ...init, method: method.toUpperCase() });
}
