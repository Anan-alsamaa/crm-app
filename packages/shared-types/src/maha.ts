import { z } from 'zod';

/**
 * MAHA, THE CHAT ASSISTANT (owner, 2026-11-09).
 *
 * How a chat runs while Maha is on (`conversations.ai_active`):
 *  - the session starts with Maha's introduction instead of the "an agent
 *    will reply within 2 minutes" welcome;
 *  - no agent is assigned and no inbox alert rings; agents see the chat, but
 *    their message box is locked until somebody turns Maha off for it;
 *  - each customer message is answered by Maha, or handed over: Maha says a
 *    colleague will take over, the chat goes through the NORMAL routing
 *    (the assignment rules pick the agent) with the new-chat alert, and the
 *    response-time clock starts at that moment;
 *  - the first message the agent sends is preceded by "<first name> from
 *    customer service is with you", so the name is always the person who is
 *    really talking to the customer.
 *
 * Everything Maha writes is an agent-STYLE message with NO person behind it
 * (`sender_user` null - the automated convention), so no report, SLA clock or
 * unread count ever mistakes it for a human answer.
 */

/** What a message Maha's flow wrote says it is (`messages.source`). */
export const MAHA_SOURCES = ['maha', 'maha_handover', 'agent_joined'] as const;
export type MahaSource = (typeof MAHA_SOURCES)[number];

export function isMahaSource(source: string | null | undefined): boolean {
  return (MAHA_SOURCES as readonly string[]).includes(source ?? '');
}

export type MahaLocale = 'ar' | 'en';

/** Maha's introduction, in place of the welcome template. */
export function mahaIntro(locale: MahaLocale): string {
  return locale === 'en'
    ? 'Hi, this is Maha from Yiji customer service 🌷 How can I help you?'
    : 'أهلاً، معك مها من خدمة عملاء يجي 🌷 كيف أقدر أخدمك؟';
}

/** What the customer reads when Maha passes the chat to a person. */
export function mahaHandoverLine(locale: MahaLocale): string {
  return locale === 'en'
    ? "I'm passing you to a colleague now, one moment 🌷"
    : 'سأحوّلك الآن لأحد زملائي ليكمل معك، لحظات 🌷';
}

/** Said once, just before the agent's first message after a handover. */
export function agentJoinedLine(locale: MahaLocale, firstName: string): string {
  const name = firstName.trim();
  return locale === 'en'
    ? `${name} from customer service is with you`
    : `معك ${name} من خدمة العملاء`;
}

/**
 * A first message that is ONLY a greeting needs no answer beyond Maha's
 * introduction, which already asks how she can help.
 */
export function isGreetingOnly(text: string): boolean {
  return /^\s*(السلام عليكم( ورحمة الله( وبركاته)?)?|سلام|هلا|هلا والله|مرحبا|مرحباً|اهلا|أهلا|hi|hello|hey|salam)(?:[\s!.،,؟?]|🌹|🌷)*$/iu.test(
    text,
  );
}

/** Why Maha handed over, in words for the agent's banner. */
export function mahaHandoverReasonLabel(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  const known: Record<string, string> = {
    asked_for_person: 'Customer asked for a person',
    asked_for_compensation: 'Customer asked for compensation or a refund',
    asked_if_bot: 'Customer asked if they are talking to a bot',
    attachment: 'Customer sent an image, voice note or file',
    reply_limit: 'Maha reached her reply limit',
    outside_hours: "Outside Maha's hours",
    spend_cap: "Maha's monthly budget is used up",
    empty_reply: 'Maha had no answer',
    mentions_compensation: 'Maha tried to mention compensation (blocked)',
    claims_human: 'Maha tried to claim to be human (blocked)',
    ai_timeout: 'Maha did not answer in time',
    agent_took_over: 'An agent turned Maha off',
  };
  if (known[r]) return known[r];
  if (r.startsWith('ai_error')) return 'The AI service failed';
  return r || 'Needs a person';
}

/** Queue the socket gateway consumes: Maha's decisions, delivered to the chat. */
export const MahaDeliverJob = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deliver'),
    conversationId: z.string(),
    /** The customer message this answers; stale if a newer one has arrived. */
    forMessageId: z.string(),
    action: z.enum(['reply', 'handover']),
    reply: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
  }),
  z.object({
    /** No answer within the deadline: a person takes it. */
    kind: z.literal('watchdog'),
    conversationId: z.string(),
    forMessageId: z.string(),
  }),
]);
export type MahaDeliverJob = z.infer<typeof MahaDeliverJob>;

/** How long a customer waits for Maha before a person takes over. */
export const MAHA_WATCHDOG_MS = 45_000;
