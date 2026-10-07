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

  // `00` is the international dialling prefix — 00966… is the same number as
  // +966…, and it is what a phone's own contact card often stores. Without
  // this the 00 fell through to the "already local" branch below and became
  // `0966537301009`: a FOURTH spelling of a customer, matching nothing.
  const dialled = digits.startsWith('00') ? digits.slice(2) : digits;

  // Carries the country code, with or without a + and with or without the
  // trunk 0 that some people leave in after it (+966 05… happens).
  if (dialled.startsWith(SA_CODE)) {
    const rest = dialled.slice(SA_CODE.length).replace(/^0+/, '');
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

/**
 * Is this text a phone number somebody could be reached on?
 *
 * The question the Add-ticket page asks before offering to create a customer
 * from what the agent typed. One field takes either a name or a number
 * (owner, 2026-09-16), and the two need telling apart: "Ahmed" that matches
 * nobody is a search that failed, while "0501234567" that matches nobody is a
 * customer we have not met yet.
 *
 * Deliberately permissive about SHAPE and strict about SUBSTANCE. It accepts
 * the spacing, dashes, brackets and `+` that people actually type, then judges
 * the digits underneath:
 *
 *   - a local Saudi mobile, `05XXXXXXXX` (10 digits), or the bare `5XXXXXXXX`
 *     that autofill sometimes produces;
 *   - the same number carrying `966` / `+966` / `00966`;
 *   - an international number, 8–15 digits, when it is written with a leading
 *     `+` — the one signal that says "this is a full number from elsewhere"
 *     rather than a fragment.
 *
 * It rejects anything with letters in it, and anything too short to be a real
 * number — so a half-typed `05012` does not offer to become a customer while
 * the agent is still typing.
 */
export function isDialablePhone(raw: string | null | undefined): boolean {
  const input = (raw ?? '').trim();
  if (!input) return false;
  // A name is not a number. Letters anywhere disqualify it outright, which is
  // what separates "Ahmed" from "0501234567" in the one field that takes both.
  if (/[A-Za-z؀-ۿ]/.test(input)) return false;

  const digits = input.replace(/\D/g, '');
  if (!digits) return false;

  // Normalising first means every spelling of one number is judged the same
  // way, rather than each branch below re-deriving the country code.
  const local = normalizePhone(input);
  if (/^05\d{8}$/.test(local)) return true;

  // From another country, and said so with a +. Without that marker a long
  // digit string is more likely a mis-paste than a foreign number.
  if (input.startsWith('+') || input.startsWith('00')) {
    return digits.replace(/^0+/, '').length >= 8 && digits.length <= 15;
  }
  return false;
}

/**
 * A contact's display name, with a phone-like name rendered CANONICALLY.
 *
 * Many customers have no name: they arrive from the app or a WhatsApp
 * complaint and the number becomes the name. Those names were stored in
 * whatever shape the source used — on live production, 44 of 77 contacts carry
 * a numeric name and they disagree with each other (`+966564490993`,
 * `509040892`) while the `phone` COLUMN beside them is correctly `05…`. The
 * same customer therefore reads two different ways on one screen, and two
 * customers with the same number look like different people (owner,
 * 2026-10-01).
 *
 * So a name that is ONLY a phone number is normalised to `05…`. A real name is
 * returned untouched — `isDialablePhone` rejects anything with letters, which
 * is what keeps "Ahmed" out of this — and so is a foreign number, which must
 * not be made to look Saudi.
 *
 * AND A MACHINE EMAIL IS NOT A NAME EITHER (ops, 2026-10-04: *"still shows
 * email in agent portal"*).
 *
 * Yiji registers app customers against a synthesised address, so its order
 * records carry names like `176732564464481@AFCO.com` and
 * `9665410950517557@yiji.com` — measured on the live late-orders queue, where
 * most rows look like that. Those reached the screen untouched, because
 * `isDialablePhone` rejects anything with an `@` and the name was returned as
 * given. An agent then sees a machine address where they need the customer's
 * mobile — the number they dial, WhatsApp and paste into Yiji.
 *
 * So an email-shaped name falls back to the PHONE, exactly as a blank name
 * does. Only when there is no phone is the address shown, because something is
 * better than an empty cell and it is at least an identifier.
 *
 * A REAL name containing an `@` is not a thing; requiring a dot-suffix after
 * the `@` keeps the test narrow, so a nickname like "a@b" is left alone.
 *
 * DISPLAY ONLY. It changes nothing in the database; it makes every surface
 * agree about what is already there.
 */
const MACHINE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function displayContactName(
  name: string | null | undefined,
  fallbackPhone?: string | null,
): string {
  /* "منيره - +966562088955" reads as "منيره", and "+966… - +966…" reduces to
     the one number, which the phone branch below then renders as `05…`. */
  const raw = stripTrailingPhones((name ?? '').trim());
  if (!raw) return normalizePhone(fallbackPhone) || '';
  /* An address is not a name. The phone is what the agent needs; the address
     only stands in when there is no phone at all. */
  if (MACHINE_EMAIL.test(raw)) return normalizePhone(fallbackPhone) || raw;
  if (!isDialablePhone(raw)) return raw;
  /* Only a SAUDI number is rewritten. `normalizePhone` returns a foreign
     number unchanged, so comparing against it keeps "+447…" as it was. */
  const local = normalizePhone(raw);
  return /^05\d{8}$/.test(local) ? local : raw;
}

/** ` - `, ` – `, ` — ` or ` | ` with space either side: how Yiji glues a number on. */
const NAME_SEPARATOR = /\s+[-–—|]\s+/g;

/**
 * Peel off trailing ` - <phone>` segments.
 *
 * Yiji's `fullName` often carries the customer's number after the name —
 * `منيره - +966562088955` — and sometimes is nothing BUT the number, twice:
 * `+966564490993 - +966564490993`. Only a segment that is itself a dialable
 * number is removed, so a real double-barrelled name ("Al - Harbi") is left as
 * typed.
 */
function stripTrailingPhones(name: string): string {
  let out = name;
  for (;;) {
    let last: RegExpExecArray | null = null;
    for (const m of out.matchAll(NAME_SEPARATOR)) last = m as RegExpExecArray;
    if (!last) return out;
    const tail = out.slice(last.index + last[0].length);
    if (!isDialablePhone(tail)) return out;
    out = out.slice(0, last.index).trim();
  }
}

/**
 * A name worth STORING (or putting in an edit box), or null when there is none.
 *
 * The write-side twin of `displayContactName` (owner, 2026-10-07): the agent
 * portal showed `+966508315325` as the customer's NAME because the gateway
 * copied Yiji's `fullName` into the contact when it was created, and for many
 * customers that "name" is just their number. The number already lives in the
 * `phone` column, in the one canonical shape; repeating it as a name, in a
 * different shape, is how one customer came to read two ways on one screen.
 *
 * So:
 *   - a trailing ` - +966…` is removed (`منيره - +966562088955` -> `منيره`);
 *   - a name that is ONLY a phone number is no name at all -> null;
 *   - so is a machine address (`9665410950517557@yiji.com`);
 *   - blank -> null, never `""`.
 *
 * Unlike `displayContactName` there is no phone fallback: the point is to say
 * "we do not know their name yet", which is what lets an agent type it.
 */
export function cleanContactName(raw: string | null | undefined): string | null {
  const name = stripTrailingPhones((raw ?? '').trim());
  if (!name) return null;
  if (isDialablePhone(name)) return null;
  if (MACHINE_EMAIL.test(name)) return null;
  return name;
}
