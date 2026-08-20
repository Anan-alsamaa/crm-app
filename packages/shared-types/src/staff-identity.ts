/**
 * How a member of staff is identified, named, and signed in.
 *
 * Staff sign in with an EMPLOYEE ID, not an email. Directus authenticates by
 * email and that is not something worth fighting, so the email is DERIVED from
 * the employee id: `4417` is stored and authenticated as `4417@staff.example.com`.
 *
 * Deriving it rather than looking it up is the whole point. A lookup would mean
 * an unauthenticated endpoint that turns an employee id into an email address —
 * which also answers "does this employee id exist?" for anyone who asks. A
 * deterministic rule needs no endpoint, so there is nothing to ask.
 *
 * Real email addresses live in `contact_email` and are optional, because for
 * most staff there is no work address to give and requiring one only meant
 * inventing them.
 */

/**
 * The domain staff identities live under.
 *
 * `example.com` and its subdomains are reserved by RFC 2606 — they can never
 * be registered by anyone — so nothing can ever be delivered to one of these
 * addresses by accident. That is what makes it safe to mint them for people
 * who have no email at all.
 *
 * NOT a `.local` domain, which was the first choice: Directus validates the
 * email field and rejects it outright, so every account patched with one
 * failed silently in bulk. A minted identity still has to be a valid address.
 */
export const STAFF_EMAIL_DOMAIN = 'staff.example.com';

/** Employee ids are compared and stored lowercase, so `A17` and `a17` are one person. */
export function normalizeLoginName(loginName: string): string {
  return loginName.trim().toLowerCase();
}

/**
 * The Directus identity to authenticate with, from whatever was typed.
 *
 * An input containing `@` is taken as an email and used verbatim. That is not a
 * fallback for convenience — it is what keeps every account that predates this
 * change able to sign in, including the administrator, whose identity is a real
 * address and should stay one.
 *
 * Returns `null` for empty input rather than a half-built address, so a caller
 * cannot accidentally attempt `@staff.local`.
 */
export function loginIdentity(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw;
  return `${normalizeLoginName(raw)}@${STAFF_EMAIL_DOMAIN}`;
}

/** Is this a minted staff identity rather than a real address? */
export function isStaffIdentity(email: string | null | undefined): boolean {
  return (email ?? '').toLowerCase().endsWith(`@${STAFF_EMAIL_DOMAIN}`);
}

/**
 * The employee id back out of an identity — `4417@staff.local` → `4417`.
 * `null` for a real email address, which has no employee id inside it.
 */
export function loginNameFromIdentity(email: string | null | undefined): string | null {
  if (!isStaffIdentity(email)) return null;
  return (email ?? '').slice(0, -`@${STAFF_EMAIL_DOMAIN}`.length);
}

/** The fields any surface needs to render a person's name. */
export interface StaffNameFields {
  first_name?: string | null;
  last_name?: string | null;
  login_name?: string | null;
  email?: string | null;
}

/**
 * What a person is CALLED — their first name.
 *
 * There is no separate "display name" field. One was tried and removed: it
 * asked an administrator to type a third name for somebody whose first name
 * was already on the form, and the two then drifted. The first name is the
 * name people are addressed by here, so it is the one shown.
 *
 * The fallbacks matter more than they look. An employee id identifies a real
 * person and is the next best thing to a name; a minted `4417@staff.example.com`
 * is an id wearing a domain and comes last. Never returns an empty string — a
 * row rendering as a blank cannot be acted on, and "Unknown" at least says the
 * NAME is missing rather than the person.
 */
export function staffDisplayName(
  user: StaffNameFields | null | undefined,
  fallback = 'Unknown',
): string {
  if (!user) return fallback;
  const first = user.first_name?.trim();
  if (first) return first;
  const login = user.login_name?.trim();
  if (login) return login;
  const fromEmail = loginNameFromIdentity(user.email) ?? user.email?.trim();
  return fromEmail || fallback;
}

/**
 * First and last together, for lists where people have to be told apart.
 *
 * An admin scanning a user list needs "Ali Hassan" and "Ali Otaibi" to be two
 * rows, not two Alis. Everywhere else — a greeting, an author byline — the
 * first name is what a colleague would say out loud, so `staffDisplayName` is
 * the right call there.
 */
export function staffFullName(
  user: StaffNameFields | null | undefined,
  fallback = 'Unknown',
): string {
  const both = [user?.first_name?.trim(), user?.last_name?.trim()].filter(Boolean).join(' ');
  return both || staffDisplayName(user, fallback);
}
