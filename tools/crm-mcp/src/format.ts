import { API_HOST } from './guard.js';

/**
 * The first line of EVERY tool result. There is no staging mode; this line is
 * what makes it impossible to read an answer and wonder which system it came
 * from.
 */
export const HEADER = `[PRODUCTION · read-only · ${API_HOST}]`;

export function withHeader(body: string): string {
  return `${HEADER}\n${body}`;
}

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Parse a Directus/Yiji timestamp; a zone-less stamp is taken as UTC. */
export function parseTs(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(value);
  const iso = hasZone || !value.includes('T') ? value : `${value}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `2026-10-08 14:03 KSA (11:03Z)` — Riyadh (UTC+3) first, UTC in brackets. */
export function when(value: unknown): string {
  const d = parseTs(value);
  if (!d) return '-';
  const ksa = new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString();
  return `${ksa.slice(0, 10)} ${ksa.slice(11, 16)} KSA (${d.toISOString().slice(11, 16)}Z)`;
}

/**
 * A YIJI timestamp. Yiji stamps are Riyadh WALL-CLOCK with no zone, so a naked
 * stamp is read as +03:00 (the same rule as `parseYijiTimestamp` in
 * shared-types); reading it as UTC puts every order three hours in the future.
 */
export function whenYiji(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) || !value.includes('T');
  return when(zoned ? value : `${value}+03:00`);
}

/** The Riyadh calendar day of a timestamp, `YYYY-MM-DD`. */
export function riyadhDay(value: unknown): string {
  const d = parseTs(value);
  if (!d) return 'unknown';
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A date range in RIYADH days, as UTC bounds for a filter.
 * `from`/`to` are `YYYY-MM-DD` (inclusive, Riyadh) or full ISO instants.
 */
export function riyadhRange(from?: string, to?: string): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (from) {
    out.gte = day.test(from)
      ? new Date(`${from}T00:00:00+03:00`).toISOString()
      : (parseTs(from)?.toISOString() ?? from);
  }
  if (to) {
    if (day.test(to)) {
      const end = new Date(`${to}T00:00:00+03:00`);
      end.setUTCDate(end.getUTCDate() + 1);
      out.lt = end.toISOString();
    } else {
      out.lt = parseTs(to)?.toISOString() ?? to;
    }
  }
  return out;
}

/** A Directus filter clause for a date range on `field`, or null when no range. */
export function rangeFilter(field: string, from?: string, to?: string): object | null {
  const r = riyadhRange(from, to);
  const clause: Record<string, string> = {};
  if (r.gte) clause._gte = r.gte;
  if (r.lt) clause._lt = r.lt;
  return Object.keys(clause).length ? { [field]: clause } : null;
}

/**
 * The stored phone form is `05XXXXXXXX`. Turn what a person types
 * (`+966 5x...`, `9665x...`, `5x...`, `05x...`) into the string to search
 * for. A short fragment is searched as typed (digits only).
 */
export function phoneNeedle(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('00966')) return `0${digits.slice(5)}`;
  if (digits.startsWith('966') && digits.length >= 12) return `0${digits.slice(3)}`;
  if (digits.startsWith('5') && digits.length === 9) return `0${digits}`;
  return digits;
}

/** `First Last`, from a Directus user object (or the raw id, or '-'). */
export function person(u: unknown): string {
  if (!u) return '-';
  if (typeof u === 'string') return u;
  const o = u as {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    id?: string;
  };
  const name = [o.first_name, o.last_name].filter(Boolean).join(' ').trim();
  return name || o.email || o.id || '-';
}

/** A field off a possibly-expanded relation. */
export function rel(v: unknown, key: string): string {
  if (v && typeof v === 'object') {
    const x = (v as Record<string, unknown>)[key];
    return x === null || x === undefined || x === '' ? '-' : String(x);
  }
  return v === null || v === undefined ? '-' : String(v);
}

export function clip(text: unknown, max = 400): string {
  const s = text === null || text === undefined ? '' : String(text);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Keys whose VALUES must never leave this server, at any depth. */
export const SECRET_KEY =
  /password|passwd|secret|credential|auth_data|api[_-]?key|private[_-]?key|^token|[_-]token$|^tfa/i;

/** Deep copy with every secret-looking key's value replaced. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Keep a tool answer to a size a conversation can carry. */
export function capText(s: string, max = 60_000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (truncated at ${max} characters)` : s;
}
