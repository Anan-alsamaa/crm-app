import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { cn, SparkleIcon, Spinner } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * ENHANCE — make what the agent already wrote better.
 *
 * Asked for by operations (2026-10-04): *"The agent will enter text in the
 * input field and click Enhance. The AI should then suggest a better reply
 * based on the entered text."*
 *
 * The capability already existed and nobody could find it. `/suggest-reply`
 * has taken an optional `draft` since it was written, and its prompt branches
 * on exactly that — "Agent's draft to refine" when a draft is present,
 * "Propose a reply" when it is not. What was missing was a way to ASK for it:
 * the only entry point was a button called "Suggest reply" inside a collapsed
 * AI panel, which reads as "write one for me" rather than "fix mine", so an
 * agent with a half-written reply never pressed it.
 *
 * So this is one button in the composer row, next to Quick replies, and it is
 * DISABLED until there is something to enhance — the disabled state is the
 * explanation of what the button does.
 *
 * Deliberately NOT a rewrite-in-place with no way back: the composer keeps an
 * undo (see `onEnhanced`), because an agent who loses a carefully worded reply
 * to a worse one stops trusting the button after a single bad result.
 */

export interface EnhanceButtonProps {
  conversationId: string;
  /** The AI cost bucket. Absent means AI is off for this vendor — no button. */
  vendorId: string | undefined;
  /** What the agent has typed. The button is dead without it. */
  draft: string;
  /**
   * Called with the improved text. The composer owns how it lands — it has to
   * route through `onDraftChange` so the box GROWS, and it keeps the previous
   * draft for undo.
   */
  onEnhanced: (text: string) => void;
  /** Surfaces a failure where the agent is looking. */
  onError?: (message: string) => void;
  className?: string;
}

export function EnhanceButton({
  conversationId,
  vendorId,
  draft,
  onEnhanced,
  onError,
  className,
}: EnhanceButtonProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  /*
   * THE LANGUAGE IS STATED, never inferred.
   *
   * The gateway treats a stated locale as overriding the language of the
   * thread, which is what is wanted: the agent's portal language is an
   * explicit choice about which language this customer is answered in. Same
   * precedence the AI panel and the reply drafter already use.
   */
  const locale = i18n.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';

  const enhance = useMutation({
    mutationFn: () =>
      ai.suggestReply({ userId: user?.id ?? '', vendorId: vendorId ?? '' }, conversationId, {
        draft,
        locale,
      }),
    onSuccess: (data) => {
      const text = data.reply?.trim();
      /*
       * AN EMPTY ANSWER IS A FAILURE, not an enhancement.
       *
       * Writing it through would silently ERASE the agent's draft — the worst
       * possible outcome for a button whose whole promise is improving it.
       */
      if (!text) {
        onError?.(String(t('ai.enhanceEmpty', { defaultValue: 'No suggestion came back.' })));
        return;
      }
      onEnhanced(text);
    },
    onError: (e) => {
      const err = e as AiError;
      /* `ai.error.*` is where the panel's messages already live — one
         vocabulary for AI failures, so a rate limit reads the same wherever it
         is hit. Only the Enhance-specific fallback is new. */
      onError?.(
        err?.code === 'rate_limited'
          ? String(
              t('ai.enhanceRateLimited', {
                defaultValue: 'Too many AI requests. Try again shortly.',
              }),
            )
          : String(t('ai.enhanceFailed', { defaultValue: 'Could not enhance that reply.' })),
      );
    },
  });

  /* AI off for this vendor: no button at all, rather than a dead one. */
  if (!vendorId) return null;

  /* Nothing typed is nothing to enhance. Whitespace is nothing typed. */
  const empty = draft.trim().length === 0;
  const busy = enhance.isPending;

  return (
    <button
      type="button"
      onClick={() => enhance.mutate()}
      disabled={empty || busy}
      /* WHY it is disabled, since a disabled button cannot explain itself and
         "nothing happens" is how the emoji button was reported. */
      title={
        empty
          ? String(
              t('ai.enhanceHint', {
                defaultValue: 'Type a reply first, then Enhance improves it.',
              }),
            )
          : undefined
      }
      aria-label={String(t('ai.enhance', { defaultValue: 'Enhance' }))}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-2xs font-semibold',
        'ring-1 ring-inset transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        empty || busy
          ? 'cursor-not-allowed bg-secondary/40 text-muted-foreground/60 ring-border/60'
          : 'bg-secondary/50 text-muted-foreground ring-border hover:bg-primary/[0.08] hover:text-primary hover:ring-primary/25',
        className,
      )}
    >
      {busy ? <Spinner size={13} /> : <SparkleIcon size={13} />}
      {t('ai.enhance', { defaultValue: 'Enhance' })}
    </button>
  );
}
