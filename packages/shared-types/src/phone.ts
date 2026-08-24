/*
 * ONE canonical way to write a Saudi mobile number: `05XXXXXXXX`.
 *
 * WHY THIS EXISTS: contacts are matched by EXACT phone equality
 * (`upsertContact`). The Yiji app sends `+9665XXXXXXXX`; a customer standing in
 * a shop types `05XXXXXXXX`. Those are the same human and the same handset, and
 * without normalising they became two contacts — which meant a walk-in customer
 * who IS registered on Yiji got a fresh, unlinked contact and no order history,
 * defeating the point of asking for the number at all.
 *
 * WHY THE LOCAL FORM RATHER THAN E.164. This used to canonicalise to
 * `+9665XXXXXXXX` on the reasoning that the platform already stored it that
 * way. It did not, consistently: the live table held FOUR shapes at once —
 * `+966…`, `966…`, `05…` and a bare `5…` — so "what the platform stores" was
 * never a single thing to align with, and two customers were sitting in it
 * twice under two spellings of the same number.
 *
 * `05XXXXXXXX` is the form every agent reads out on a call, every customer
 * types, and every branch prints. Canonicalising to the shape people actually
 * use means the stored value and the spoken value are the same string, so a
 * number pasted from a ticket into a dialler works and a search for what the
 * customer told you finds them.
 *
 * The product operates in Saudi Arabia only. A number from anywhere else is
 * returned untouched rather than mangled into a local form it cannot have —
 * see the last branch.
 */

/** Saudi Arabia. The only country this product operates in today. */
const SA_CODE = '966';

/**
 * `+966 5X XXX XXXX`, `9665XXXXXXXX`, `5XXXXXXXX`, `05XXXXXXXX` → `05XXXXXXXX`.
 *
 * Returns the input trimmed when it cannot be recognised, rather than throwing
 * or inventing a country code: a number this does not understand is better
 * stored as the customer typed it than silently turned into a different one.
 * There is one such value in the live table — 18 digits, from a mis-paste — and
 * leaving it visibly wrong is what lets somebody notice and fix it.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const input = (raw ?? '').trim();
  if (!input) return '';
  const digits = input.replace(/\D/g, '');
  if (!digits) return input;

  // Carries the country code, with or without a + and with or without the
  // trunk 0 that some people leave in after it (+966 05… happens).
  if (digits.startsWith(SA_CODE)) {
    const rest = digits.slice(SA_CODE.length).replace(/^0+/, '');
    return rest ? `0${rest}` : input;
  }
  // Already local: 05XXXXXXXX. Collapse a doubled trunk 0 but keep the single.
  if (digits.startsWith('0')) {
    const rest = digits.replace(/^0+/, '');
    return rest ? `0${rest}` : input;
  }
  // Bare national number, which is what a phone's own autofill sometimes hands
  // over. Length-checked so a random 5-leading string is not given a 0.
  if (digits.startsWith('5') && digits.length === 9) return `0${digits}`;

  // Some other country, or something this does not recognise. A leading + in
  // the original is a strong signal it was already international, and turning
  // that into an 05 number would claim it is Saudi.
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
 * The same number in E.164: `+9665XXXXXXXX`.
 *
 * We store `05…` because that is what people say and type. Yiji stores
 * `+966503813055` — confirmed by reading a real order back from their own API,
 * not assumed — and a coupon lands in THEIR system, so it goes in their shape.
 *
 * The rule generally: one canonical form inside, converted at the single point
 * where an external system wants something else. `whatsappNumber` below does
 * the same job for wa.me, which wants no `+`.
 *
 * Returns null rather than a guess when the number is not a Saudi mobile, so a
 * caller can decide whether to send nothing or to send what it has.
 */
export function internationalPhone(raw: string | null | undefined): string | null {
  const local = normalizePhone(raw);
  const digits = local.replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `+${SA_CODE}${digits.slice(1)}`;
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  // Already international and not Saudi — pass it through rather than refuse;
  // it is still a valid thing to hand an external system.
  if (local.startsWith('+')) return local;
  return null;
}

/**
 * The same number as WhatsApp needs it: `9665XXXXXXXX`, digits only.
 *
 * The one place the local form is deliberately abandoned, because wa.me is not
 * ours — it takes an international number and a local one opens a chat with
 * nobody, silently. Storing `05…` everywhere and converting at the single point
 * of use is the trade: one canonical form in our data, one conversion where an
 * external system demands otherwise.
 *
 * Returns null rather than a guess when the number is not a Saudi mobile. A
 * wa.me link built from a landline or a foreign number is a dead end the agent
 * only discovers in front of the customer.
 *
 * Lives here because it was implemented TWICE — once in the agent portal's
 * ticket reply and again in the customer widget's offline strip — and two
 * copies of a rule about phone numbers is how one of them quietly stops
 * matching the other.
 */
export function whatsappNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `${SA_CODE}${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `${SA_CODE}${digits}`;
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (/^009665\d{8}$/.test(digits)) return digits.slice(2);
  return null;
}

/**
 * How a number should be SHOWN. Same as stored — deliberately.
 *
 * Kept as a named function rather than left implicit so that a future decision
 * to display numbers differently (spacing, an international prefix for a second
 * country) has one place to happen, instead of being sprinkled across the
 * surfaces that render a contact.
 */
export function formatPhone(raw: string | null | undefined): string {
  return normalizePhone(raw);
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
