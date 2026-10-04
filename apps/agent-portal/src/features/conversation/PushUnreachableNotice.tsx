import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';
import { saudiWaNumber } from '../tickets/whatsapp.js';

/**
 * THIS CUSTOMER CANNOT RECEIVE APP NOTIFICATIONS — NUDGE THEM ON WHATSAPP.
 *
 * About a third of customers cannot be reached by push (measured: 39
 * conversations in 14 days; 20 production conversations carry
 * `push_unreachable_at` today). For an AGENT-INITIATED chat that is the whole
 * problem: the customer has no chat window open, so the push was the only thing
 * telling them to look. Without it the agent writes into a thread nobody will
 * ever see.
 *
 * ## Why this is a fallback and not the default
 *
 * Push and WhatsApp are different mechanisms, not competing options, and the
 * asymmetry decides it: **push brings the customer back into the CRM chat;
 * WhatsApp pulls the conversation out of it.** Defaulting to WhatsApp would
 * move support conversations into a channel the CRM cannot see, measure for SLA
 * or report on — quietly undoing the one-chat-surface work.
 *
 * So the nudge goes out on WhatsApp and says "reply in the app": the message is
 * a prompt to come back, not a place to hold the conversation.
 *
 * ## It must never appear on a customer-started chat
 *
 * They are already looking at it. A warning that their notifications are broken
 * would be noise on the one thread where it does not matter — and it would
 * appear on roughly a third of the inbox.
 *
 * No new WhatsApp infrastructure: `saudiWaNumber` and the `wa.me` link are the
 * same ones the ticket page has used since the ops portal proved them out.
 */

export interface PushUnreachableNoticeProps {
  /** Set when the push gateway said this customer is permanently unreachable. */
  pushUnreachableAt: string | null | undefined;
  /** Who opened the chat. Only an agent-initiated one gets the nudge. */
  initiatedBy: 'customer' | 'agent' | null | undefined;
  /** The customer's number, in whatever shape it is stored. */
  phone: string | null | undefined;
  /** Their name, for the drafted message. */
  name?: string | null;
  className?: string;
}

/**
 * Whether to offer the nudge at all.
 *
 * Exported so the rule is testable on its own: it is three conditions and every
 * one of them is a reason somebody would otherwise see this wrongly.
 */
export function shouldOfferWhatsAppNudge(input: {
  pushUnreachableAt: string | null | undefined;
  initiatedBy: 'customer' | 'agent' | null | undefined;
  phone: string | null | undefined;
}): boolean {
  /* Reachable by push — the ordinary case, and nothing to say. */
  if (!input.pushUnreachableAt) return false;
  /*
   * The CUSTOMER started this. They have the chat open; telling their agent
   * that notifications are broken helps nobody and would show on a third of
   * the inbox. `initiated_by` defaults to `customer`, so an absent value is
   * treated as customer-started rather than assumed to be an agent chat.
   */
  if (input.initiatedBy !== 'agent') return false;
  /* No usable Saudi mobile — there is nothing to open. Offering a dead button
     is worse than offering nothing. */
  return !!saudiWaNumber(input.phone);
}

export function PushUnreachableNotice({
  pushUnreachableAt,
  initiatedBy,
  phone,
  name,
  className,
}: PushUnreachableNoticeProps) {
  const { t } = useTranslation();

  if (!shouldOfferWhatsAppNudge({ pushUnreachableAt, initiatedBy, phone })) return null;

  const number = saudiWaNumber(phone);
  /*
   * THE MESSAGE SAYS "REPLY IN THE APP".
   *
   * This is the whole design in one sentence. A nudge that reads like an
   * invitation to chat here would move the conversation to WhatsApp, where the
   * CRM cannot see it, cannot measure first response and cannot report on it.
   */
  const message = String(
    t('conversation.pushFallback.message', {
      name: name?.trim() || '',
      defaultValue:
        'Hello, this is Yiji customer care. We have sent you a message in the Yiji app — please open the app to read it and reply there.',
    }),
  );
  const href = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl',
        'border border-warning/30 bg-warning/[0.07] px-3 py-2',
        'text-2xs leading-relaxed text-foreground',
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        {t('conversation.pushFallback.notice', {
          defaultValue:
            'This customer cannot receive app notifications — they may not know you wrote.',
        })}
      </span>
      {/* A LINK, not a button: it opens WhatsApp, and a middle-click or a long
          press should behave the way every other outbound link does. */}
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1',
          'bg-foreground/[0.06] font-semibold text-foreground',
          'ring-1 ring-inset ring-border transition-colors duration-fast',
          'hover:bg-foreground/[0.1]',
        )}
      >
        {t('conversation.pushFallback.action', { defaultValue: 'Nudge on WhatsApp' })}
      </a>
    </div>
  );
}
