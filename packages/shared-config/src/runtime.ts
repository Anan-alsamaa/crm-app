/**
 * Browser-side helpers with no dependencies.
 *
 * Deliberately separate from env.ts: that module imports zod to parse server
 * environment variables, so importing a helper from it drags zod into the
 * portal bundle. That is not just weight — it put zod in a chunk that the
 * report page's own chunk already depended on, and the circular initialisation
 * threw "Cannot access 'z' before initialization" at runtime, in the built
 * bundle only. The whole tickets report rendered as a permanent skeleton.
 */
/**
 * Re-point a baked-in loopback URL at whatever host the page is served from.
 *
 * The refresh token is an httpOnly `SameSite=lax` cookie, so the browser sends
 * it only when the API is same-site with the page. A build that hardcodes
 * `localhost` therefore signs people out on the next reload the moment anyone
 * reaches the portal by any other name — over the LAN, from a phone, or simply
 * via 127.0.0.1. The symptom is a session that dies on refresh, which reads as
 * a broken password rather than a cookie rule, so it gets "fixed" by resetting
 * the password and comes straight back.
 *
 * Only loopback hosts are rewritten: a real deployment names its API and must
 * be left exactly as configured.
 */
export function onPageHost(url: string): string {
  const loc = (globalThis as { location?: { hostname?: string } }).location;
  const page = loc?.hostname;
  if (!page) return url;
  try {
    const target = new URL(url);
    const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
    if (!LOOPBACK.includes(target.hostname) || target.hostname === page) return url;
    target.hostname = page;
    // No trailing slash: callers concatenate paths onto this.
    return target.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * One filename rule for every export the product produces.
 *
 * An exported file leaves the app and lands in someone's downloads folder,
 * an email, a shared drive — next to exports from every other system they
 * use. `stores-132.csv` or `ticket-report-30d.csv` says nothing there about
 * what it is or when it was taken, and the trailing number reads as noise.
 *
 *   exportFileName('Stores')                        Sara CRM - Stores - 2026-08-16.csv
 *   exportFileName('Tickets', { scope: 'last 30 days' })
 *                                   Sara CRM - Tickets (last 30 days) - 2026-08-16.csv
 *   exportFileName('Backup', { ext: 'json' })       Sara CRM - Backup - 2026-08-16.json
 *
 * Characters are restricted to what every OS accepts in a filename, so a
 * scope carrying a store name or a date range cannot produce a file the user
 * is unable to save.
 */
export function exportFileName(
  what: string,
  opts: { scope?: string; ext?: string; date?: Date } = {},
): string {
  const { scope, ext = 'csv', date } = opts;
  const safe = (v: string) =>
    v
      .replace(/[/:*?"<>|\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const stamp = (date ?? new Date()).toISOString().slice(0, 10);
  const subject = scope ? `${safe(what)} (${safe(scope)})` : safe(what);
  return `Sara CRM - ${subject} - ${stamp}.${ext}`;
}
