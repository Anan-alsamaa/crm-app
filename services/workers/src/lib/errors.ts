/**
 * Turn anything that was thrown into a line worth logging.
 *
 * `err instanceof Error ? err.message : String(err)` — the idiom used all over
 * this service — produces the string **"[object Object]"** for a Directus SDK
 * rejection, because those are plain objects carrying an `errors` array rather
 * than `Error` instances. That is how a permission gap on `coupon_approvals`
 * came to be reported as:
 *
 *   {"msg":"could not read undelivered coupons — skipping this sweep",
 *    "err":"[object Object]"}
 *
 * which says something failed and refuses to say what. A log line that cannot
 * name its own cause is barely better than no log line at all, and it turns a
 * one-minute fix into an afternoon.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;

  const e = err as
    | {
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
        message?: string;
        response?: { status?: number };
        status?: number;
      }
    | null
    | undefined;
  if (!e || typeof e !== 'object') return String(err);

  /*
   * Directus's shape: `{ errors: [{ message, extensions: { code } }] }`. The
   * CODE is the half that matters most — FORBIDDEN tells you to look at role
   * permissions, where the message alone ("You don't have permission…") reads
   * like a login problem.
   */
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const parts = e.errors.map((x) => {
      const code = x?.extensions?.code;
      const msg = x?.message ?? 'unknown error';
      return code ? `${code}: ${msg}` : msg;
    });
    const status = e.response?.status ?? e.status;
    return status ? `${status} ${parts.join('; ')}` : parts.join('; ');
  }
  if (typeof e.message === 'string' && e.message) return e.message;

  // Last resort, but still the actual VALUE rather than its type name.
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err);
  }
}
