/**
 * What an SLA policy COVERS, and which policy wins when several could.
 *
 * A policy used to say only how long: first response in N minutes, resolution
 * in M. The only thing it could say about *which* tickets it governed was the
 * priority, so every policy anyone created was, in practice, a pair of numbers.
 * Two things were missing and both are here:
 *
 *   1. COVERAGE. A roach in the food and a missing sauce sachet are not the
 *      same promise, and neither is a complaint that arrived by phone versus
 *      one on Instagram. A policy now narrows by priority, ticket type, arrival
 *      channel and brand — any combination, each optional.
 *
 *   2. A DETERMINISTIC WINNER. With one dimension, overlapping policies were
 *      already possible ("high" in two policies) and the worker took whichever
 *      Directus happened to return first — so the promise a ticket was held to
 *      depended on row order. With four dimensions overlap is the normal case,
 *      not the edge case, so the rule has to be stated: the most SPECIFIC
 *      policy wins.
 *
 * Shared rather than duplicated because the admin console has to show the
 * operator the same answer the worker will reach. A rule that lives in two
 * places is a rule that will disagree with itself.
 */

/**
 * WHICH OBJECT a policy governs.
 *
 * Until now every policy was a ticket policy, because a ticket was the only
 * thing with a clock. But the two promises this business actually makes are not
 * both about tickets:
 *
 *   - "we answer a chat within N minutes" — a CHAT promise. It is measured from
 *     the customer's first message to the agent's first reply, and it is over
 *     long before anyone decides whether a ticket is warranted.
 *   - "we solve a complaint within N hours" — a TICKET promise.
 *
 * Holding both in one policy row is what produced the earlier failure: the
 * ticket carried a first-response deadline that nothing in the product could
 * ever satisfy, because the reply that answered the customer happened in the
 * chat, before the ticket existed. Every such ticket breached and stayed
 * breached. Separating the objects is the fix — a policy now says which clock
 * it is, and only the matching sweep reads it.
 *
 * Absent means `ticket`: every policy written before this field existed was a
 * ticket policy, and silently re-reading them as chat policies would move live
 * promises onto a different object.
 */
export type SlaGoverns = 'ticket' | 'chat';

/** The two objects a policy can govern, in the order the console lists them. */
export const SLA_GOVERNS = ['ticket', 'chat'] as const;

/** What this policy governs, defaulting an unset or unrecognised value to `ticket`. */
export function policyGoverns(policy: { governs?: string | null }): SlaGoverns {
  return policy?.governs === 'chat' ? 'chat' : 'ticket';
}

/**
 * Which of a policy's two targets is the one that matters for what it governs.
 *
 * A chat policy's promise is its first-response minutes; a ticket policy's is
 * its resolution minutes. The other number is still stored — the column is
 * required and a policy row is edited by hand — but nothing reads it, and a
 * console that displayed both would be showing an operator a promise that is
 * not being kept because it is not being measured.
 */
export function policyTargetMinutes(policy: {
  governs?: string | null;
  first_response_minutes?: number | null;
  resolution_minutes?: number | null;
}): number | null {
  return policyGoverns(policy) === 'chat'
    ? (policy.first_response_minutes ?? null)
    : (policy.resolution_minutes ?? null);
}

/** One dimension of coverage: null / empty both mean "any value". */
export type SlaScopeList = readonly string[] | null | undefined;

/**
 * The coverage half of an `sla_policies` row.
 *
 * Deliberately loose about the member type: the worker reads these back from
 * Directus as plain JSON, where nothing guarantees the strings are still
 * members of any enum — a complaint type retired from `option_lists` is still
 * sitting in policies that named it. Comparison is by string value, which is
 * how the tickets store it too.
 */
export interface SlaPolicyScope {
  /** See `SlaGoverns`. Absent means `ticket`. */
  governs?: string | null;
  applies_to_priority?: SlaScopeList;
  applies_to_type?: SlaScopeList;
  applies_to_source?: SlaScopeList;
  applies_to_brand?: SlaScopeList;
}

/** The ticket's side of the comparison. Any field may be unknown. */
export interface SlaTicketFacts {
  priority?: string | null;
  complaintType?: string | null;
  complaintSource?: string | null;
  brandName?: string | null;
}

/** The four dimensions, in the order the console presents them. */
export const SLA_SCOPE_KEYS = [
  'applies_to_priority',
  'applies_to_type',
  'applies_to_source',
  'applies_to_brand',
] as const;
export type SlaScopeKey = (typeof SLA_SCOPE_KEYS)[number];

const FACT_OF: Record<SlaScopeKey, keyof SlaTicketFacts> = {
  applies_to_priority: 'priority',
  applies_to_type: 'complaintType',
  applies_to_source: 'complaintSource',
  applies_to_brand: 'brandName',
};

/** A dimension that actually narrows anything — a non-empty array of strings. */
function named(list: SlaScopeList): string[] {
  return Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v.length > 0) : [];
}

/**
 * How many dimensions this policy names. Zero means it names none.
 *
 * Doubles as the SPECIFICITY score: a policy that pins priority *and* brand is
 * a more deliberate statement than one that pins priority alone, so it wins.
 */
export function scopeSpecificity(policy: SlaPolicyScope): number {
  return SLA_SCOPE_KEYS.reduce((n, k) => n + (named(policy[k]).length > 0 ? 1 : 0), 0);
}

/**
 * Does this policy govern this ticket?
 *
 * Every dimension the policy NAMES must contain the ticket's value; dimensions
 * it leaves empty are not tested. So `{priority: [high]}` covers every high
 * ticket, and `{priority: [high], brand: [Herfy]}` covers only Herfy's.
 *
 * A policy that names NOTHING covers nothing — the opposite of what "no
 * restrictions" suggests, and deliberate. The compensation clone ships five
 * active policies with no coverage at all; reading those as "governs
 * everything" would put every ticket in the system under a promise nobody
 * wrote. It is also the safer failure: an unclaimed ticket is visibly
 * unclaimed, whereas a wrongly-claimed one silently reports as on-time.
 *
 * A ticket missing the value a policy tests (no complaint type recorded, say)
 * is NOT covered by that policy — it cannot be shown to satisfy the condition,
 * and guessing in either direction would be a promise made on a blank.
 */
export function policyCovers(policy: SlaPolicyScope, ticket: SlaTicketFacts): boolean {
  let tested = 0;
  for (const key of SLA_SCOPE_KEYS) {
    const values = named(policy[key]);
    if (values.length === 0) continue;
    tested++;
    const fact = ticket[FACT_OF[key]];
    if (typeof fact !== 'string' || !values.includes(fact)) return false;
  }
  return tested > 0;
}

/**
 * The policy that governs this ticket, or none.
 *
 * Most specific wins. Ties break on name, then id — arbitrary, but STABLE:
 * the same ticket must land on the same policy every sweep, or its deadline
 * would move under it whenever Directus reordered a page of rows.
 */
export function pickSlaPolicy<T extends SlaPolicyScope & { id: string; name?: string | null }>(
  policies: readonly T[],
  ticket: SlaTicketFacts,
  /**
   * Which clock is being set. A chat policy and a ticket policy can carry
   * identical coverage — in this deployment they deliberately do, both covering
   * all four priorities — so without this the ticket sweep would happily attach
   * the chat's five-minute promise to a complaint and breach it instantly.
   */
  governs: SlaGoverns = 'ticket',
): T | null {
  const matches = policies.filter((p) => policyGoverns(p) === governs && policyCovers(p, ticket));
  if (matches.length === 0) return null;
  return [...matches].sort(
    (a, b) =>
      scopeSpecificity(b) - scopeSpecificity(a) ||
      (a.name ?? '').localeCompare(b.name ?? '') ||
      a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * Human summary of a policy's coverage, for the console card.
 *
 * Returns one phrase per named dimension; an empty array means the policy
 * covers nothing, which the caller should say out loud rather than render as
 * blank space — a policy governing no tickets looks identical to a working one
 * otherwise, and that is how five dead policies went unnoticed.
 */
export function scopeSummary(policy: SlaPolicyScope): string[] {
  return SLA_SCOPE_KEYS.flatMap((k) => {
    const values = named(policy[k]);
    return values.length > 0 ? [values.join(', ')] : [];
  });
}

/**
 * WHEN an SLA clock runs.
 *
 * `null` means round the clock, which is what every policy meant until the
 * console could say otherwise — and a four-hour resolution target counted
 * through the night produces a breach logged at 03:00 against a branch that
 * was shut, which is not a missed promise, it is a promise nobody made.
 *
 * The engine that consumes this (services/workers/src/lib/sla-clock.ts) has
 * been correct since it was written; nothing could reach it. The shape lives
 * here so the console writing the column and the worker reading it are looking
 * at one definition.
 */
export interface SlaBusinessHours {
  /** IANA zone, e.g. 'Asia/Riyadh'. The weekdays and windows below are read in
   *  THIS zone, not UTC — 09:00-17:00 means 09:00-17:00 where the branch is. */
  timezone: string;
  /** Weekday -> open windows, keys '0'..'6' with 0 = Sunday. Missing or empty
   *  means closed that day. */
  days: Record<string, Array<[string, string]>>;
}

/** Weekday labels in the order `SlaBusinessHours.days` is keyed (0 = Sunday). */
export const SLA_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * One-line reading of a policy's working hours, for the console card.
 *
 * Collapses the common case — the same window every open day — into
 * "Sun-Thu 09:00-17:00" rather than listing seven rows, and falls back to
 * naming the days when they genuinely differ.
 */
export function businessHoursSummary(hours: SlaBusinessHours | null | undefined): string | null {
  if (!hours) return null;
  const open = SLA_WEEKDAYS.map((_, i) => hours.days?.[String(i)] ?? []).map((w) =>
    Array.isArray(w) && w.length > 0 ? w : null,
  );
  const openIdx = open.map((w, i) => (w ? i : -1)).filter((i) => i >= 0);
  if (openIdx.length === 0) return null;
  const first = JSON.stringify(open[openIdx[0]!]);
  const uniform = openIdx.every((i) => JSON.stringify(open[i]) === first);
  const window = (open[openIdx[0]!] ?? []).map(([a, b]) => `${a}-${b}`).join(', ');
  const short = (i: number) => SLA_WEEKDAYS[i]!.slice(0, 3);
  // Contiguous run of open days reads as a range; anything else is listed.
  const contiguous = openIdx.every((d, k) => k === 0 || d === openIdx[k - 1]! + 1);
  const days =
    openIdx.length === 7
      ? 'Every day'
      : contiguous && openIdx.length > 1
        ? `${short(openIdx[0]!)}-${short(openIdx[openIdx.length - 1]!)}`
        : openIdx.map(short).join(', ');
  return uniform ? `${days} ${window}` : days;
}

/* ── Working-hours arithmetic for the REPORTS ─────────────────────────────── */

/** Minutes since midnight for an 'HH:MM' string ('17:00' -> 1020, '24:00' -> 1440). */
function parseHHMM(hhmm: string): number {
  const [h, m] = String(hhmm)
    .split(':')
    .map((v) => Number(v));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** One formatter per zone: building an Intl.DateTimeFormat is the expensive part. */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = ZONE_FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    ZONE_FORMATTERS.set(tz, f);
  }
  return f;
}

/** Local wall-clock fields of `instant` (epoch ms) in `tz`. */
function zoneFields(instant: number, tz: string) {
  const parts = zoneFormatter(tz).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (local - UTC) in minutes for `instant` in `tz`, DST-aware. */
function zoneOffsetMinutes(instant: number, tz: string): number {
  const p = zoneFields(instant, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - instant) / 60_000);
}

/**
 * Epoch ms for `minutesIntoDay` after local midnight of (year, month, day) in
 * `tz`. The same two-pass conversion as the SLA engine's `zonedToUtc`
 * (services/workers/src/lib/sla-clock.ts), so a window edge lands on the same
 * instant in a report as it does in a deadline.
 */
function zonedMs(
  year: number,
  month: number,
  day: number,
  minutesIntoDay: number,
  tz: string,
): number {
  const h = Math.floor(minutesIntoDay / 60);
  const m = Math.floor(minutesIntoDay % 60);
  const s = Math.round((minutesIntoDay - h * 60 - m) * 60);
  const guess = Date.UTC(year, month - 1, day, h, m, s);
  let utc = guess - zoneOffsetMinutes(guess, tz) * 60_000;
  utc = guess - zoneOffsetMinutes(utc, tz) * 60_000;
  return utc;
}

/** True when the hours name at least one open window somewhere in the week. */
function hasAnyWindow(hours: SlaBusinessHours): boolean {
  return Object.values(hours.days ?? {}).some((w) => Array.isArray(w) && w.length > 0);
}

/**
 * HOW MUCH OF AN INTERVAL FELL INSIDE WORKING HOURS, in milliseconds.
 *
 * The reports' half of the SLA clock (owner, 2026-10-08). The SLA engine
 * (`computeDueAt` in services/workers/src/lib/sla-clock.ts) already counts a
 * deadline in working minutes only; the reports measured the same chats on the
 * wall clock, so a customer who wrote at 05:35 and got a reply at 08:52 — before
 * the 09:00 shift — read as a 3h17m first response against a promise that had
 * not even started running. This is the inverse of `computeDueAt`:
 *
 *     businessMsBetween(start, computeDueAt(start, N, hours), hours) === N * 60_000
 *
 * Same reading of the hours as the engine: windows and weekdays are LOCAL to
 * `hours.timezone` (DST-aware via Intl), '24:00' closes at the next midnight,
 * a missing or empty weekday is closed.
 *
 * - `hours` null/undefined ⇒ round the clock: plain `end - start`.
 * - `end <= start` ⇒ 0, never negative.
 * - Hours that name NO window at all ⇒ wall clock as well. The engine refuses
 *   such a policy (it would never reach a deadline); a report answering 0 for
 *   every chat would be the silent-zero failure, so it falls back instead.
 */
export function businessMsBetween(
  start: Date,
  end: Date,
  hours: SlaBusinessHours | null | undefined,
): number {
  const a = start.getTime();
  const b = end.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  if (!hours || !hours.days || !hasAnyWindow(hours)) return b - a;

  const tz = hours.timezone || 'UTC';
  const first = zoneFields(a, tz);
  let total = 0;
  // One pass per LOCAL calendar day, from the start's day until a day begins
  // at or after the end. Date.UTC normalises day overflow, so `first.day + i`
  // walks month and year boundaries correctly.
  for (let i = 0; ; i++) {
    const cal = new Date(Date.UTC(first.year, first.month - 1, first.day + i));
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const d = cal.getUTCDate();
    if (i > 0 && zonedMs(y, mo, d, 0, tz) >= b) break;
    const windows = hours.days[String(cal.getUTCDay())] ?? [];
    if (!Array.isArray(windows)) continue;
    for (const w of windows) {
      if (!Array.isArray(w) || w.length < 2) continue;
      const open = zonedMs(y, mo, d, parseHHMM(w[0]), tz);
      const close = zonedMs(y, mo, d, parseHHMM(w[1]), tz);
      const overlap = Math.min(b, close) - Math.max(a, open);
      if (overlap > 0) total += overlap;
    }
  }
  return total;
}

/**
 * `businessMsBetween` for two ISO strings, in SECONDS. Null when either is
 * missing or unparsable, or when the clock ran backwards (`to` before `from`) —
 * a negative interval is no measurement, and reporting it as 0 would be a lie
 * in the flattering direction.
 */
export function businessSecondsBetween(
  from: string | null | undefined,
  to: string | null | undefined,
  hours: SlaBusinessHours | null | undefined,
): number | null {
  if (!from || !to) return null;
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  if (b.getTime() < a.getTime()) return null;
  return businessMsBetween(a, b, hours) / 1000;
}

/**
 * Read a `business_hours` column value into the shape, or null.
 *
 * Directus returns a json column parsed, but a hand-edited row can carry a
 * string, and a malformed value must read as "round the clock" (the old
 * behaviour) rather than throw inside a report.
 */
export function parseBusinessHours(raw: unknown): SlaBusinessHours | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { timezone?: unknown; days?: unknown };
  if (!o.days || typeof o.days !== 'object' || Array.isArray(o.days)) return null;
  return {
    timezone: typeof o.timezone === 'string' && o.timezone ? o.timezone : 'UTC',
    days: o.days as SlaBusinessHours['days'],
  };
}

/** The working hours each clock runs on, as the reports need them. */
export interface SlaHoursByObject {
  chat: SlaBusinessHours | null;
  ticket: SlaBusinessHours | null;
}

/**
 * Which working hours the reports use for chats and for tickets, from the
 * `sla_policies` rows.
 *
 * Only ACTIVE policies count, split by `governs`. Of those, the first (by name,
 * then id — the same stable order the engine breaks ties with) that carries
 * usable hours wins. None carrying hours ⇒ null ⇒ wall clock, which is what
 * every report did before.
 */
export function slaHoursByGoverns(
  policies: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
    governs?: string | null;
    active?: boolean | null;
    business_hours?: unknown;
  }>,
): SlaHoursByObject {
  const pick = (governs: SlaGoverns): SlaBusinessHours | null => {
    const rows = policies
      .filter((p) => !!p && p.active !== false && policyGoverns(p) === governs)
      .sort(
        (a, b) =>
          (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''),
      );
    for (const p of rows) {
      const h = parseBusinessHours(p.business_hours);
      if (h && hasAnyWindow(h)) return h;
    }
    return null;
  };
  return { chat: pick('chat'), ticket: pick('ticket') };
}
