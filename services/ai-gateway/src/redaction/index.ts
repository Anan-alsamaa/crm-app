/**
 * PII redaction.
 *
 * Every outbound payload sent to an AI provider is redacted in-place so
 * sensitive identifiers never leave the perimeter. Each match is replaced
 * with a typed placeholder (`<EMAIL_1>`, `<PHONE_2>`, ...) so the provider
 * sees consistent tokens and we can map back when needed.
 *
 * Categories covered (spec FR-022 + Phase 7 T085):
 *   - email
 *   - phone (international + local, conservative)
 *   - address (PO Box + numbered street patterns)
 *   - payment card (13–19 digits, Luhn-validated only)
 *   - IBAN (country code + check digits + bban, simple length + structure check)
 *   - national-id / SSN-like (XXX-XX-XXXX)
 *
 * The order matters: cards/IBAN run first so a 16-digit card number isn't
 * partially eaten by a phone pattern.
 */

export type PiiCategory = 'email' | 'phone' | 'address' | 'card' | 'iban' | 'national_id';

export interface RedactionEntry {
  /** Placeholder token inserted into the redacted text. */
  placeholder: string;
  /** Category. */
  category: PiiCategory;
  /** Original raw value (kept in-memory only — never sent outbound). */
  raw: string;
}

export interface RedactionResult {
  /** Text with placeholders. Safe to send to a provider. */
  redacted: string;
  /** Map of placeholder → original value, for un-redaction on the response. */
  entries: RedactionEntry[];
}

/* ── Detectors ─────────────────────────────────────────────────────── */

// RFC 5322-ish but pragmatic. No comments / quoted-local-part / IDN.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone: optional +, then 7–15 digits with spaces / dashes / parens. Reject
// runs that are clearly card-like (≥13 digits) — handled by card detector first.
const PHONE_RE =
  /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?|\d{1,4}[\s.-]?){1,4}\d{2,4}(?!\d)/g;

// Street address: `123 Main St`, `45 King Road, Apt 6`, `742 Evergreen Terrace`.
// Stops at the next comma / period / newline. Triggered by a leading number.
const ADDRESS_RE =
  /\b\d{1,5}[\s\-/]?[A-Za-z]?\s+(?:[A-Z][a-zA-Z]+\.?\s?){1,4}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Way|Court|Ct\.?|Place|Pl\.?|Plaza|Square|Sq\.?|Highway|Hwy\.?|Parkway|Pkwy\.?|Terrace|Ter\.?|Crescent|Cres\.?|Circle|Cir\.?|Trail|Trl\.?)\b/g;

// PO Box.
const POBOX_RE = /\bP\.?\s?O\.?\s?Box\s+\d{1,7}\b/gi;

// Card: 13–19 digits, allowing spaces/dashes every 4. Luhn-validated below.
const CARD_RE = /(?<!\d)(?:\d[ -]*?){13,19}(?!\d)/g;

// IBAN: 2 letters + 2 digits + 11–30 alphanumerics (max 34 total).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// US-style SSN (and similar national-id patterns).
const NATIONAL_ID_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/* ── Luhn check for cards ─────────────────────────────────────────── */

export function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/* ── IBAN structural check ────────────────────────────────────────── */

export function ibanValid(value: string): boolean {
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  // Move first 4 chars to the end, convert letters → numbers (A=10..Z=35).
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const n = code >= 65 ? code - 55 : code - 48;
    // Process digit-by-digit using mod-97 on a running remainder.
    const block = String(n);
    for (const d of block) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/* ── Core redact loop ─────────────────────────────────────────────── */

interface Pass {
  regex: RegExp;
  category: PiiCategory;
  /** Optional extra validator — return true to accept, false to skip. */
  accept?: (match: string) => boolean;
}

/**
 * Run the redaction passes IN ORDER. Earlier-replaced placeholders won't be
 * touched by later passes because they look like `<EMAIL_1>` and miss all
 * patterns.
 */
const PASSES: Pass[] = [
  { regex: CARD_RE, category: 'card', accept: luhnValid },
  { regex: IBAN_RE, category: 'iban', accept: ibanValid },
  { regex: EMAIL_RE, category: 'email' },
  { regex: NATIONAL_ID_RE, category: 'national_id' },
  { regex: POBOX_RE, category: 'address' },
  { regex: ADDRESS_RE, category: 'address' },
  { regex: PHONE_RE, category: 'phone', accept: (m) => phoneAccept(m) },
];

function phoneAccept(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  // Must look phone-shaped: 7–15 digits.
  if (digits.length < 7 || digits.length > 15) return false;
  return true;
}

type Counter = Record<PiiCategory, number>;
const newCounter = (): Counter => ({
  email: 0,
  phone: 0,
  address: 0,
  card: 0,
  iban: 0,
  national_id: 0,
});

/** Internal: redact a single string against a shared counter. */
function redactWithCounter(
  input: string,
  counter: Counter,
): { redacted: string; entries: RedactionEntry[] } {
  let working = input;
  const entries: RedactionEntry[] = [];
  for (const pass of PASSES) {
    pass.regex.lastIndex = 0;
    working = working.replace(pass.regex, (match) => {
      if (pass.accept && !pass.accept(match)) return match;
      counter[pass.category] += 1;
      const placeholder = `<${pass.category.toUpperCase()}_${counter[pass.category]}>`;
      entries.push({ placeholder, category: pass.category, raw: match });
      return placeholder;
    });
  }
  return { redacted: working, entries };
}

/** Redact a single string. */
export function redact(input: string): RedactionResult {
  return redactWithCounter(input, newCounter());
}

/**
 * Redact every string in a JSON-shaped payload deeply. Non-strings pass through.
 * Returns the redacted clone + the combined entries.
 */
export function redactDeep<T>(value: T): { redacted: T; entries: RedactionEntry[] } {
  const all: RedactionEntry[] = [];
  const counter = newCounter();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactWithCounter(v, counter);
      all.push(...r.entries);
      return r.redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { redacted: walk(value) as T, entries: all };
}

/** Reverse-map placeholders back to their original values. */
export function unredact(text: string, entries: RedactionEntry[]): string {
  let out = text;
  for (const e of entries) {
    // Replace all occurrences. Placeholders are unique strings so split+join.
    out = out.split(e.placeholder).join(e.raw);
  }
  return out;
}
