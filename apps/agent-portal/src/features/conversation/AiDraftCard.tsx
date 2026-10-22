import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItem } from '@directus/sdk';
import type { AiDraft } from '@yiji/shared-types';
import { Button, cn } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/** How long after a customer message the card keeps looking for its draft. */
const DRAFT_WAIT_MS = 60_000;

/**
 * AI AUTO-REPLY, SHADOW MODE (owner, 2026-10-13; docs/AI-AUTO-REPLY-PLAN.md).
 *
 * What the AI WOULD have answered to the customer's latest message - shown to
 * the agent only, never sent. Lets agents judge the AI before any customer
 * sees it. Appears only while that message is still unanswered; "Use this"
 * puts it in the composer (recorded as an AI suggestion) for the agent to
 * check and send.
 *
 * Read on its own query so a role that cannot read `ai_draft` loses this card
 * and nothing else.
 */
export function AiDraftCard({
  conversationId,
  awaitingMessageId,
  awaitingAt,
  onUse,
  className,
}: {
  conversationId: string;
  /** The customer message still waiting for an answer, or null if none. */
  awaitingMessageId: string | null;
  /** When that message was sent (ISO). */
  awaitingAt: string | null;
  onUse: (text: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const q = useQuery({
    // Per awaited MESSAGE: a new customer message starts a new search.
    queryKey: ['ai-draft', conversationId, awaitingMessageId],
    enabled: !!awaitingMessageId,
    retry: false,
    queryFn: async () => {
      const row = (await directus.request(
        readItem('conversations', conversationId, { fields: ['ai_draft'] } as never),
      )) as { ai_draft?: AiDraft | null } | null;
      return row?.ai_draft ?? null;
    },
    /* The draft lands a few seconds after the message: look again until it
       does - but only for the first minute, and never after an error. Where
       the feature is off (production today) no draft ever comes, and asking
       every 4 s for ever would be pure load. */
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      if ((query.state.data as AiDraft | null | undefined)?.forMessageId === awaitingMessageId)
        return false;
      const at = awaitingAt ? Date.parse(awaitingAt) : NaN;
      return Number.isFinite(at) && Date.now() - at < DRAFT_WAIT_MS ? 4000 : false;
    },
  });
  const draft = q.data;
  if (!awaitingMessageId || !draft || draft.forMessageId !== awaitingMessageId) return null;

  return (
    <div
      className={cn(
        // A soft brand card, not a dashed slot: it is a real suggestion, and
        // the "not sent" in its title already says it is provisional.
        'rounded-[1.25rem] bg-primary/[0.05] px-4 py-3 text-xs ring-1 ring-inset ring-primary/15',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-primary">
          {t('aiDraft.title', { defaultValue: 'AI suggestion - not sent' })}
        </span>
        {draft.action === 'reply' && draft.reply && (
          <Button size="sm" variant="ghost" onClick={() => onUse(draft.reply ?? '')}>
            {t('aiDraft.use', { defaultValue: 'Use this' })}
          </Button>
        )}
      </div>
      {draft.action === 'reply' && draft.reply ? (
        <p
          dir="auto"
          className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground"
        >
          {draft.reply}
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">
          {t('aiDraft.handover', {
            defaultValue: 'The AI would hand this chat to an agent: {{reason}}',
            reason: draft.reason ?? '—',
          })}
        </p>
      )}
    </div>
  );
}
