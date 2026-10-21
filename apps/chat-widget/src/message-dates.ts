import type { WidgetLocale, WidgetStrings } from './i18n.js';

/**
 * WHEN EACH MESSAGE WAS SENT (EMA-78, ops 2026-10-18).
 *
 * The conventional chat pattern: a day separator ("Today", "Yesterday",
 * "18 Oct 2026") wherever the calendar day changes, and the clock time on
 * every bubble. Both are in the VIEWER'S local time — the browser's zone,
 * exactly as the agent portal shows its timestamps.
 */

/** The local calendar day of an ISO timestamp, or '' when it is not a date. */
export function dayKey(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The messages that open a new day, so a separator goes above each. A message
 * only opens a day when its own day is known and differs from the last message
 * that HAD a known day — a bubble without a usable timestamp never splits a
 * day in two.
 */
export function daySeparatorIds(
  messages: ReadonlyArray<{ id: string; createdAt?: string | null }>,
): Set<string> {
  const out = new Set<string>();
  let current = '';
  for (const m of messages) {
    const key = dayKey(m.createdAt);
    if (key === '' || key === current) continue;
    current = key;
    out.add(m.id);
  }
  return out;
}

/** "Today" / "Yesterday" / "18 Oct 2026" (Arabic in `ar`). */
export function dayLabel(
  iso: string,
  locale: WidgetLocale,
  tr: Pick<WidgetStrings, 'today' | 'yesterday'>,
  now: Date = new Date(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return tr.today;
  if (diff === 1) return tr.yesterday;
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  } catch {
    // A runtime without full ICU still has to render something sensible.
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }
}
