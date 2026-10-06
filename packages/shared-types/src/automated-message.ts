/**
 * THE AUTOMATIC WELCOME, AND WHY IT IS NOT AN ANSWER (owner, 2026-10-06).
 *
 * After a customer's FIRST message of a session, the gateway sends operations'
 * own welcome template (`quick_replies` row "رسالة ترحيب") into the thread as a
 * real message. It must LOOK like an agent wrote it — a normal agent bubble,
 * persisted, in history, visible to agents — so it is stored with
 * `sender_type: 'agent'`.
 *
 * But nobody wrote it. A customer who has received the welcome is still
 * waiting for a person, so every place that reads an agent message as "the
 * customer has been answered" — the SLA first-response stamp, the KPI
 * first-response timing, the "replied within 5 minutes" tally, the routing
 * ladder's "did anyone reply?" count, idle-close's "who spoke last", the unread
 * reset, the agent's "You:" preview — must skip it.
 *
 * THE CONVENTION: `sender_type 'agent'` AND `sender_user` NULL. Every human
 * agent message carries the sender's user id (the gateway stamps it from the
 * authenticated socket), so a null user on an agent message can only mean no
 * human sent it. Chosen over a new column because a Directus field needs a
 * manual production step; verified on production 2026-10-06 that NO existing
 * agent message has a null `sender_user` (0 of 1,335), so the convention
 * misclassifies nothing that already exists.
 *
 * ONE helper, used everywhere, because the alternative — each consumer
 * restating the rule — is how two reports came to disagree before.
 */

/** A message row as Directus returns it (snake_case). */
export interface SenderFields {
  sender_type?: string | null;
  /**
   * The human who sent it. `null` = selected and empty. `undefined` (the key
   * absent) = the caller never SELECTED the field — see the note on
   * `isAutomatedAgentMessage`.
   */
  sender_user?: string | { id?: string | null } | null;
}

/**
 * Is this the automated agent-style message (the auto welcome) rather than a
 * person's reply?
 *
 * ONLY AN EXPLICIT `null` COUNTS. A field the caller did not request comes back
 * `undefined`, and treating that as "no human" would silently reclassify EVERY
 * agent reply as automated the first time somebody forgot to select
 * `sender_user` — every chat would read as unanswered. The
 * [[silent-empty-failures]] shape: a plausible zero. Absent means "unknown",
 * and unknown keeps the old behaviour (a reply).
 */
export function isAutomatedAgentMessage(m: SenderFields | null | undefined): boolean {
  if (!m || m.sender_type !== 'agent') return false;
  if (m.sender_user === null) return true;
  if (typeof m.sender_user === 'object' && m.sender_user !== undefined) {
    return m.sender_user.id === null;
  }
  return false;
}

/** A PERSON on our side replied: an agent message that is not the auto welcome. */
export function isHumanAgentMessage(m: SenderFields | null | undefined): boolean {
  return !!m && m.sender_type === 'agent' && !isAutomatedAgentMessage(m);
}

/**
 * The same rule as a Directus filter, for server-side counts and lookups that
 * never pull rows down (the routing ladder's outbound count, aggregates).
 * `_nnull` on `sender_user` is exactly "a human sent it".
 */
export const HUMAN_AGENT_MESSAGE_FILTER = {
  sender_type: { _eq: 'agent' },
  sender_user: { _nnull: true },
} as const;

/** Language of the customer, as far as the welcome cares. */
export type WelcomeLocale = 'ar' | 'en';

/**
 * Which template row to send: the customer's language first, else whichever
 * exists. The production row is a single BILINGUAL `ar` row, so an English
 * writer still gets it — which is right, it carries both languages.
 */
export function pickWelcomeTemplate(
  templates: { ar: string | null; en: string | null } | null | undefined,
  locale: WelcomeLocale,
): string | null {
  const first = (locale === 'en' ? templates?.en : templates?.ar)?.trim();
  if (first) return first;
  const other = (locale === 'en' ? templates?.ar : templates?.en)?.trim();
  return other || null;
}

/**
 * `{name}` substituted, or removed CLEANLY when no name is on file — the
 * placeholder AND the space or comma clinging to it, so "Welcome {name}, how
 * can we help?" reads "Welcome, how can we help?", never "Welcome , …" or a
 * literal `{name}`. The Arabic comma is a different codepoint and is handled.
 *
 * Line breaks are KEPT: the production template is two paragraphs (Arabic,
 * then English) and flattening it into one line would garble both.
 */
export function renderWelcomeTemplate(template: string, name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (n) return template.replace(/\{name\}/g, n).trim();
  return template
    .replace(/[ \t]*\{name\}[ \t]*([,،])?/g, (_m, p: string | undefined) => (p ? `${p} ` : ' '))
    .replace(/[ \t]+([,،.!؟?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}
