/**
 * SLA deadline computation (research D-04).
 *
 * - `businessHours = null` ⇒ continuous (24/7): `dueAt = start + minutes`.
 * - `businessHours` provided ⇒ deadline shifts to only count business-hour
 *   minutes (skipping nights / weekends per the per-day window list).
 *
 * Pure & deterministic so it can be unit-tested without a clock.
 */
export interface BusinessHours {
  /** IANA timezone name, e.g. 'Asia/Riyadh'. Used only as documentation here;
   *  the windowing math runs in UTC for determinism. Real-world deployments
   *  pre-translate windows into UTC offsets when the policy is authored. */
  timezone: string;
  /** Map of weekday → array of `[openHHMM, closeHHMM]` windows. Keys are '0'..'6'
   *  with 0=Sunday. Empty / missing key ⇒ closed all day. */
  days: Record<string, Array<[string, string]>>;
}

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return { h: h ?? 0, m: m ?? 0 };
}

/** Window minutes since midnight UTC for a given Date's day. */
function windowsForDay(day: Date, hours: BusinessHours): Array<[number, number]> {
  const dow = day.getUTCDay();
  const raw = hours.days[String(dow)] ?? [];
  return raw.map(([open, close]) => {
    const o = parseHHMM(open);
    const c = parseHHMM(close);
    return [o.h * 60 + o.m, c.h * 60 + c.m] as [number, number];
  });
}

/** Sets a Date to midnight UTC of the same calendar day, then advances `addDays`. */
function midnightUtc(d: Date, addDays = 0): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDays, 0, 0, 0, 0),
  );
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

  let remaining = minutes;
  let cursor = start;
  for (let i = 0; i < 60 && remaining > 0; i++) {
    const today = midnightUtc(cursor);
    const minutesIntoDay = (cursor.getTime() - today.getTime()) / 60_000;
    const windows = windowsForDay(cursor, hours);

    for (const [openMin, closeMin] of windows) {
      if (remaining <= 0) break;
      if (minutesIntoDay >= closeMin) continue; // already past this window
      const enter = Math.max(minutesIntoDay, openMin);
      const available = closeMin - enter;
      if (available <= 0) continue;
      if (available >= remaining) {
        // Deadline falls inside this window.
        return new Date(today.getTime() + (enter + remaining) * 60_000);
      }
      remaining -= available;
      // advance cursor past this window so the outer loop continues
      cursor = new Date(today.getTime() + closeMin * 60_000);
    }
    // Move to start of next day.
    cursor = midnightUtc(cursor, 1);
  }

  throw new Error(
    'SLA deadline did not fit within 60 days of business hours — check policy + windows',
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
