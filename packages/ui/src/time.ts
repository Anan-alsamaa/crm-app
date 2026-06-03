/*
 * Compact relative time for list rows. "5m", "2h", "Mon", "Mar 14".
 * Always uses the agent's locale for day-of-week / date fallback.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelative(iso: string | null | undefined, locale = 'en'): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const now = Date.now();
  const diff = now - t;

  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) {
    return new Date(t).toLocaleDateString(locale, { weekday: 'short' });
  }
  // Older — show "Mar 14" / "14 mar".
  return new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
