/*
 * One canonical way to write a Saudi mobile number.
 *
 * WHY THIS EXISTS: contacts are matched by EXACT phone equality
 * (`upsertContact`). The Yiji app sends `+9665XXXXXXXX`; a customer standing in
 * a shop types `05XXXXXXXX`. Those are the same human and the same handset, and
 * without normalising they became two contacts — which meant a walk-in
 * customer who IS registered on Yiji got a fresh, unlinked contact and no order
 * history, defeating the point of asking for the number at all. Found by
 * checking the table after a walk-in, not by reading the code.
 *
 * E.164 is the canonical form because that is what the platform already stores.
 */

/** Saudi Arabia. The only country this product operates in today. */
const SA_CODE = '966';

/**
 * `05XXXXXXXX`, `+966 5X XXX XXXX`, `9665XXXXXXXX`, `5XXXXXXXX` → `+9665XXXXXXXX`.
 *
 * Returns the input trimmed when it cannot be recognised, rather than throwing
 * or inventing a country code: a number this does not understand is better
 * stored as the customer typed it than silently turned into a different one.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const input = (raw ?? '').trim();
  if (!input) return '';
  const digits = input.replace(/\D/g, '');
  if (!digits) return input;

  // Already carries the country code, with or without a + and with or without
  // the trunk 0 that some people leave in after it (+966 05… happens).
  if (digits.startsWith(SA_CODE)) {
    const rest = digits.slice(SA_CODE.length).replace(/^0+/, '');
    return rest ? `+${SA_CODE}${rest}` : input;
  }
  // Local trunk form: 05XXXXXXXX.
  if (digits.startsWith('0')) {
    const rest = digits.replace(/^0+/, '');
    return rest ? `+${SA_CODE}${rest}` : input;
  }
  // Bare national number: 5XXXXXXXX, which is what a phone's own autofill
  // sometimes hands over.
  if (digits.startsWith('5') && digits.length === 9) return `+${SA_CODE}${digits}`;

  // Some other country, or something we do not recognise. A leading + in the
  // original is a strong signal it was already international.
  return input.startsWith('+') ? `+${digits}` : input;
}

/**
 * The stable per-customer id derived from a phone number.
 *
 * Derived from the NORMALISED number so the same handset resolves to one id
 * however it was typed — which is what lets a walk-in session and an in-app
 * session share a contact, and therefore share order history.
 */
export function phoneCustomerId(raw: string | null | undefined): string {
  const digits = normalizePhone(raw).replace(/\D/g, '');
  return `cust-${digits}`;
}
