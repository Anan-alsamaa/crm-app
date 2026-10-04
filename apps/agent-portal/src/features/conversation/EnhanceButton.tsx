import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { cn, SparkleIcon, Spinner } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * ENHANCE — the AI's improved version of what the agent wrote, OFFERED.
 *
 * Asked for by operations (2026-10-04): *"The agent will enter text in the
 * input field and click Enhance. The AI should then suggest a better reply
 * based on the entered text."* And then, having seen the first cut:
 * *"the enhance on click should display the suggestion in a separate field as
 * a reply from AI, and should not replace the text in the input text field."*
 *
 * That correction is the whole design. The first version wrote the suggestion
 * straight into the composer and offered Ctrl+Z, which is the wrong shape: the
 * agent loses what they wrote the instant they press the button, has to read
 * the replacement to find out whether it was an improvement, and has to
 * remember an undo to get back. An AI suggestion is a PROPOSAL — it belongs
 * beside the draft, where both can be read together, and it reaches the
 * composer only when the agent says so.
 *
 * So: the button sits in the composer row; the suggestion appears above it as
 * a card attributed to the AI; the draft is untouched until "Use this" is
 * pressed. Dismissing costs nothing and leaves the original exactly as typed.
 *
 * The capability itself already existed and nobody could find it:
 * `/suggest-reply` has taken an optional `draft` since it was written and its
 * prompt branches on it — "Agent's draft to refine" when present. What was
 * missing was a way to ask for it.
 */

export interface EnhanceButtonProps {
  conversationId: string;
  /** The AI cost bucket. Absent means AI is off for this vendor — no button. */
  vendorId: string | undefined;
  /** What the agent has typed. The button is dead without it. */
  draft: string;
  /**
   * Called ONLY when the agent accepts the suggestion. The composer owns how it
   * lands — it has to route through `onDraftChange` so the one-line box grows.
   */
  onAccept: (text: string) => void;
  /** Surfaces a failure where the agent is looking. */
  onError?: (message: string) => void;
  className?: string;
}

export function EnhanceButton({
  conversationId,
  vendorId,
  draft,
  onAccept,
  onError,
  className,
}: EnhanceButtonProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  /** The AI's proposal, held here rather than written into the composer. */
  const [suggestion, setSuggestion] = useState<string | null>(null);

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
      /* AN EMPTY ANSWER IS A FAILURE, not a suggestion — and showing an empty
         card would read as the feature half-working. */
      if (!text) {
        onError?.(String(t('ai.enhanceEmpty', { defaultValue: 'No suggestion came back.' })));
        return;
      }
      setSuggestion(text);
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
    <div className={cn('relative', className)}>
      {/*
        THE SUGGESTION, ABOVE THE COMPOSER.
        Positioned like the quick-replies panel, for the same reason: the
        composer sits at the bottom of the window, so anything opening downward
        opens off-screen.
      */}
      {suggestion && (
        <div
          role="region"
          aria-label={String(t('ai.suggestionTitle', { defaultValue: 'AI suggestion' }))}
          className={cn(
            'absolute bottom-full z-30 mb-2 w-[min(32rem,calc(100vw-2rem))]',
            'rounded-xl border border-primary/20 bg-popover p-3',
            'shadow-float ring-1 ring-foreground/[0.04]',
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <SparkleIcon size={12} className="text-primary" />
            <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-primary">
              {t('ai.suggestionTitle', { defaultValue: 'AI suggestion' })}
            </span>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="ms-auto text-2xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t('actions.dismiss', { ns: 'common', defaultValue: 'Dismiss' })}
            </button>
          </div>
          {/* THE WHOLE TEXT, scrollable rather than clamped: an agent must
              never send something they have not read, and this one is about to
              become their reply. */}
          <p
            dir="auto"
            className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground"
          >
            {suggestion}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onAccept(suggestion);
                setSuggestion(null);
              }}
              className="rounded-full bg-primary px-3 py-1 text-2xs font-semibold text-primary-foreground transition-colors duration-fast hover:bg-primary/90"
            >
              {t('ai.useSuggestion', { defaultValue: 'Use this' })}
            </button>
            {/* ASK AGAIN from the SAME draft — the one in the box, which is
                still exactly as the agent typed it. That is only possible
                because accepting is a separate step. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => enhance.mutate()}
              className="rounded-full px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-50"
            >
              {t('ai.regenerate', { defaultValue: 'Try again' })}
            </button>
          </div>
        </div>
      )}

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
        )}
      >
        {busy ? <Spinner size={13} /> : <SparkleIcon size={13} />}
        {t('ai.enhance', { defaultValue: 'Enhance' })}
      </button>
    </div>
  );
}
