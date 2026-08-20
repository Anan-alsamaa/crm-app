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

/**
 * The product's one date format: dd/mm/yyyy.
 *
 * Fixed rather than locale-derived, and deliberately so. These dates are read
 * by one operations team, quoted back in emails, and pasted into spreadsheets;
 * a browser that decides to render 3/4 as April 3rd in one place and March 4th
 * in another turns a date into a guess.
 *
 * Both parts are zero-padded. Beyond looking tidy it makes the strings sort
 * and align as text, which is what a column of dates in a table needs — and it
 * removes the last case where 3/4/2026 could be read either way round.
 *
 * Latin digits always — an Arabic locale would otherwise render ٣/٠٤/٢٠٢٦,
 * which is correct Arabic and unsearchable next to the same date typed by
 * anyone else.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** `formatDate` plus 24-hour time — for anything that has to be tracked, not just dated. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(iso)} ${hh}:${mm}`;
}
