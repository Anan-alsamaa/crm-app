/**
 * Closing a chat the customer has gone quiet on (owner, 2026-09-30).
 *
 * The rule, in the owner's own words: five minutes of IDLENESS where the last
 * message was the AGENT'S — the customer has not texted and has not attached
 * anything. A chat whose last message is the customer's is never closed by this,
 * because that one is waiting on US, and cutting it off would drop somebody who
 * is still waiting for help.
 *
 * The threshold is a setting, not a constant: five minutes is short for a chat,
 * and if agents report conversations closing under customers it has to be
 * raisable without a release.
 */

/** Minutes of customer silence before a chat is closed. */
export const DEFAULT_CHAT_IDLE_MINUTES = 5;

/** The `app_settings` key holding the editable threshold. */
export const CHAT_IDLE_MINUTES_KEY = 'chat_idle_close_minutes';

/**
 * Read the threshold from whatever `app_settings` holds, falling back to 5.
 *
 * Total, like `lateDeliveryMinutes`: a blank row, a typo, a negative or a wild
 * number resolves to the default rather than throwing — or, far worse, closing
 * every chat in the inbox because a stray `0` made everything idle.
 *
 * The floor is 1 minute and the ceiling a day. A `0` would close chats the
 * instant an agent replied; past a day this stops being "idle" and becomes
 * housekeeping somebody should do deliberately.
 */
export function chatIdleMinutes(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return DEFAULT_CHAT_IDLE_MINUTES;
  const whole = Math.floor(n);
  if (whole < 1 || whole > 24 * 60) return DEFAULT_CHAT_IDLE_MINUTES;
  return whole;
}

/** What the sweep needs to know about one conversation. */
export interface IdleCandidate {
  /** `open` / `pending` — a finished chat is never re-closed. */
  status?: string | null;
  /** Who sent the most recent message. */
  lastSenderType?: 'customer' | 'agent' | 'system' | null;
  /** When that message landed, as an ISO string. */
  lastMessageAt?: string | null;
  /**
   * `'agent'` when an agent opened this chat rather than the customer.
   *
   * THE EDGE CASE (owner, 2026-10-05): *"the chat should not be closed in 5
   * minutes, as the agent sent a message and the customer received the
   * notification but did not open the chat. it should be open. the close
   * applies for an ongoing conversation ignored by the customer."*
   *
   * An agent-initiated chat matches every other condition perfectly — it is
   * open, its last message IS the agent's, and it sits untouched — so the
   * sweep closed it five minutes after the agent wrote, often before the
   * customer's phone had even buzzed. The customer then opened a notification
   * into a conversation that had already said goodbye.
   *
   * Idleness is only meaningful once BOTH sides have spoken. Until the
   * customer answers, the agent is waiting on them, and waiting is not
   * abandonment.
   */
  initiatedBy?: string | null;
  /**
   * Has the customer ever said anything in this chat?
   *
   * This is what turns an agent-initiated chat into "an ongoing conversation
   * ignored by the customer" — the owner's own distinction. Once the customer
   * has replied, the five minutes apply exactly as before, because now there
   * is a conversation to go quiet on.
   */
  customerHasReplied?: boolean | null;
}

/**
 * Should this chat be closed for idleness?
 *
 * EXPORTED and used by the worker, so the tests exercise the real rule rather
 * than a restatement that would pass whatever the sweep does.
 *
 * Four conditions, and every one of them is a guard against closing something
 * that should stay open:
 *
 *  1. the chat is LIVE — `solved`/`closed` is already finished, and re-closing
 *     it would send the customer a second goodbye;
 *  2. the last message was the AGENT'S — the owner's rule. A customer's message
 *     means the ball is with us;
 *  3. there IS a last message — a chat nobody has spoken in has no idleness to
 *     measure, and `null` must never read as "infinitely idle";
 *  4. the customer has had a turn — an agent-initiated chat they have not
 *     opened yet is waiting on them, not abandoned by them (owner, 2026-10-05);
 *  5. enough time has passed.
 */
export function shouldCloseForIdle(
  c: IdleCandidate,
  idleMinutes: number,
  now: number = Date.now(),
): boolean {
  const status = (c.status ?? '').trim().toLowerCase();
  if (status !== 'open' && status !== 'pending') return false;
  if (c.lastSenderType !== 'agent') return false;
  if (!c.lastMessageAt) return false;

  /*
   * AN AGENT-INITIATED CHAT THE CUSTOMER HAS NOT ANSWERED YET STAYS OPEN.
   *
   * This is condition 5, and it is the one that was missing. The other four
   * are all satisfied by a chat an agent just started — open, last message the
   * agent's, timestamped, five minutes old — so it was closed while the
   * customer was still looking at the notification. The customer then tapped
   * through into a chat that had already said goodbye, which reads as the
   * business hanging up on someone it approached.
   *
   * `customerHasReplied` is what distinguishes the owner's two cases: before
   * the first customer message there is no conversation to abandon, and
   * afterwards the ordinary rule resumes with no exception at all.
   *
   * BOTH are required. `initiatedBy` alone would keep an agent-started chat
   * open for ever once the customer had replied and gone quiet — the very
   * thing the sweep exists for.
   */
  if (c.initiatedBy === 'agent' && !c.customerHasReplied) return false;

  const at = Date.parse(c.lastMessageAt);
  // An unparseable date is not "very old" — it is unknown, and closing on it
  // would be closing on a guess.
  if (!Number.isFinite(at)) return false;

  return now - at >= idleMinutes * 60_000;
}

/**
 * THE GOODBYE, in the customer's own language.
 *
 * The owner's standing rule: the customer is the king. So this says nothing
 * about them being slow, absent or unresponsive — the chat closing is presented
 * as our housekeeping, the door is explicitly left open, and it thanks them.
 *
 * Read the two aloud before changing either. "You did not reply" is the sentence
 * this exists to avoid.
 */
export const IDLE_CLOSE_MESSAGE = {
  ar:
    'نشكر تواصلك معنا 🌷 سيتم إغلاق هذه المحادثة الآن لإتاحة المجال لخدمتك بشكل أسرع في أي وقت. ' +
    'يسعدنا دائمًا خدمتك — أرسل لنا رسالة جديدة في أي وقت تحتاجنا وسنكون في خدمتك فورًا.',
  en:
    'Thank you for reaching out to us 🌷 We are closing this chat for now so we can be ready to help you again quickly. ' +
    'It is always a pleasure to serve you — just send us a new message whenever you need us and we will be right with you.',
} as const;

/**
 * Which wording to send.
 *
 * Arabic is the default because most customers here write in Arabic, so an
 * unknown locale should land on the language most of them read rather than on
 * English. Only an explicit `en` switches.
 */
export function idleCloseMessage(locale: string | null | undefined): string {
  const l = (locale ?? '').trim().toLowerCase();
  return l.startsWith('en') ? IDLE_CLOSE_MESSAGE.en : IDLE_CLOSE_MESSAGE.ar;
}

/**
 * The language a customer is actually writing in.
 *
 * Neither `conversations` nor `contacts` stores a locale — I checked the live
 * schema before adding one, and their own words are better evidence than a
 * preference nobody sets. So: any Arabic letter in what they wrote means send
 * Arabic.
 *
 * ANY, not most. A customer writing "ok تمام" is an Arabic speaker, and the
 * asymmetry is deliberate: sending Arabic to a bilingual customer is fine,
 * sending English to somebody who only reads Arabic is not.
 *
 * Nothing to go on — an attachment with no text, or only digits — falls through
 * to Arabic via `idleCloseMessage`.
 */
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

export function detectLocale(texts: ReadonlyArray<string | null | undefined>): 'ar' | 'en' {
  for (const t of texts) {
    if (t && ARABIC_LETTER.test(t)) return 'ar';
  }
  /* No Arabic seen. Only claim English when there was actually something to
     read — `idleCloseMessage` treats an empty answer as Arabic. */
  return texts.some((t) => !!t && t.trim() !== '') ? 'en' : 'ar';
}
