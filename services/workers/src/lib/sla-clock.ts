/**
 * SLA deadline computation (research D-04).
 *
 * - `businessHours = null` ⇒ continuous (24/7): `dueAt = start + minutes`.
 * - `businessHours` provided ⇒ the deadline counts only business-hour minutes.
 *   The per-day windows AND the weekday are interpreted in the policy's IANA
 *   `timezone` (e.g. 'Asia/Riyadh'), NOT in UTC — a 09:00–17:00 Sun–Thu policy
 *   means 09:00–17:00 *local* time. UTC offsets (and DST, where applicable) are
 *   resolved via `Intl.DateTimeFormat`, so results are correct for any zone; a
 *   `timezone: 'UTC'` policy behaves exactly as plain UTC.
 *
 * Pure & deterministic (no ambient clock) so it can be unit-tested.
 */
export interface BusinessHours {
  /** IANA timezone name, e.g. 'Asia/Riyadh'. The weekday keys + window times
   *  below are interpreted in THIS zone. */
  timezone: string;
  /** Map of weekday → array of `[openHHMM, closeHHMM]` windows. Keys are '0'..'6'
   *  with 0=Sunday (local weekday). Empty / missing key ⇒ closed all day. */
  days: Record<string, Array<[string, string]>>;
}

/** Minutes since midnight for an 'HH:MM' string ('17:00' → 1020, '24:00' → 1440). */
function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Offset (local − UTC) in minutes for `instant` in `tz`, DST-aware. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local wall-clock parts of a UTC `instant` in `tz`. weekday: 0=Sun..6=Sat. */
function tzParts(
  instant: Date,
  tz: string,
): {
  year: number;
  month: number; // 1..12
  day: number;
  weekday: number;
  minutesIntoDay: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY[get('weekday')] ?? 0,
    minutesIntoDay: Number(get('hour')) * 60 + Number(get('minute')) + Number(get('second')) / 60,
  };
}

/** UTC instant for `minutesIntoDay` after local midnight of (year,month,day) in `tz`. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  minutesIntoDay: number,
  tz: string,
): Date {
  const h = Math.floor(minutesIntoDay / 60);
  const m = Math.floor(minutesIntoDay % 60);
  const s = Math.round((minutesIntoDay - h * 60 - m) * 60);
  const guessMs = Date.UTC(year, month - 1, day, h, m, s);
  // Subtract the zone offset to get the UTC instant; one refinement pass covers
  // the rare case where the offset differs across a DST boundary.
  let utcMs = guessMs - tzOffsetMinutes(new Date(guessMs), tz) * 60_000;
  utcMs = guessMs - tzOffsetMinutes(new Date(utcMs), tz) * 60_000;
  return new Date(utcMs);
}

function windowsForWeekday(weekday: number, hours: BusinessHours): Array<[number, number]> {
  const raw = hours.days[String(weekday)] ?? [];
  return raw.map(([open, close]) => [parseHHMM(open), parseHHMM(close)] as [number, number]);
}

/**
 * Compute the deadline `start + minutes` of business-hour time.
 * Throws if no business-hour windows are configured at all (would loop).
 */
export function computeDueAt(start: Date, minutes: number, hours: BusinessHours | null): Date {
  if (!hours) return new Date(start.getTime() + minutes * 60_000);

  // Quick sanity: at least one window somewhere in the week.
  const hasAnyWindow = Object.values(hours.days).some((w) => w && w.length > 0);
  if (!hasAnyWindow) {
    throw new Error('SLA business_hours has no windows — would never reach the deadline');
  }

  const tz = hours.timezone || 'UTC';
  let remaining = minutes;
  let cursor = start;

  // One iteration per local day; 366 days is an ample horizon for any real SLA.
  for (let i = 0; i < 366 && remaining > 0; i++) {
    const p = tzParts(cursor, tz);
    for (const [openMin, closeMin] of windowsForWeekday(p.weekday, hours)) {
      if (remaining <= 0) break;
      if (p.minutesIntoDay >= closeMin) continue; // already past this window
      const enter = Math.max(p.minutesIntoDay, openMin);
      const available = closeMin - enter;
      if (available <= 0) continue;
      if (available >= remaining) {
        // Deadline falls inside this window — convert local wall-clock → UTC.
        return zonedToUtc(p.year, p.month, p.day, enter + remaining, tz);
      }
      remaining -= available;
    }
    // Advance to local midnight of the next day.
    cursor = zonedToUtc(p.year, p.month, p.day + 1, 0, tz);
  }

  throw new Error(
    'SLA deadline did not fit within a year of business hours — check policy + windows',
  );
}

/**
 * Convenience: compute both first-response and resolution deadlines from a ticket
 * created at `createdAt`, given the policy's minutes + business hours.
 */
export function computeDeadlines(
  createdAt: Date,
  firstResponseMinutes: number,
  resolutionMinutes: number,
  hours: BusinessHours | null,
): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  return {
    firstResponseDueAt: computeDueAt(createdAt, firstResponseMinutes, hours),
    resolutionDueAt: computeDueAt(createdAt, resolutionMinutes, hours),
  };
}

/** Warning timestamp = the moment when `pct%` of the way to the deadline has elapsed. */
export function warningAt(start: Date, dueAt: Date, pct: number): Date {
  const elapsed = (dueAt.getTime() - start.getTime()) * (pct / 100);
  return new Date(start.getTime() + elapsed);
}
