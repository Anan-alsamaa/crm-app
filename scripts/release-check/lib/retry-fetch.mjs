/**
 * A BUSY SERVER IS NOT A FAILED CHECK (2026-10-11).
 *
 * v1.47.1's prod checks ran two minutes after the services restarted, inside a
 * 3-second window where Directus answered some requests with an error instead
 * of data. The checks read that error body as "no rows", and reported
 * "permissions missing" and "no vendor" for things that were fine; a re-run
 * passed 38/38.
 *
 * Every request the checks make now goes through this: a network error, a
 * 429 or a 5xx is retried (2 s, 5 s, 10 s) before the answer is believed. A
 * 4xx is an answer and is never retried, so a real permission problem still
 * fails at once. Only idempotent reads are retried — a POST that may have
 * landed is never sent twice, except /auth/login which writes nothing.
 */
const DELAYS_MS = [2_000, 5_000, 10_000];
const transient = (status) => status === 429 || status >= 500;

export function installRetryingFetch(base = globalThis.fetch) {
  const retrying = async (input, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const url = String(typeof input === 'string' ? input : (input?.url ?? input));
    const safe =
      method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || url.endsWith('/auth/login');
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await base(input, init);
        if (!safe || !transient(res.status) || attempt >= DELAYS_MS.length) return res;
        console.log(`  (retry) ${method} ${url.split('?')[0]} answered ${res.status}, retrying`);
      } catch (err) {
        if (!safe || attempt >= DELAYS_MS.length) throw err;
        console.log(
          `  (retry) ${method} ${url.split('?')[0]} failed (${err?.message ?? err}), retrying`,
        );
      }
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  };
  globalThis.fetch = retrying;
  return retrying;
}
