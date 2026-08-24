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

/**
 * Is this a customer id WE invented from a phone number, rather than one Yiji
 * issued?
 *
 * Deliberately next to `phoneCustomerId`, because the two are the same fact
 * read in opposite directions and separating them is how they drift.
 *
 * WHY THIS MATTERS. A walk-in visitor types a phone number into a QR page and
 * the gateway mints `cust-<digits>` so the session has an identity. That is a
 * perfectly good local handle — and it is NOT a Yiji customer id. It was
 * nonetheless being written into `contacts.external_customer_id`, a column
 * whose entire meaning is "the id Yiji issued for this customer", where it
 * looked exactly like the real thing. Five contacts in this database carried
 * one.
 *
 * The cost is not cosmetic: the coupon push sends that column to Yiji as
 * `userId`, so a fabricated value would be handed to their resolver as if it
 * were an account. Unknown has to look unknown.
 */
export function isPhoneDerivedCustomerId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^cust-\d+$/.test(id.trim());
}
