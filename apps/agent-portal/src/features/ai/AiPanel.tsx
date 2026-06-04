import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, cn, Pill, Spinner } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * AI panel — shows 7 actions per conversation. Each action calls the
 * gateway via TanStack mutation; result renders inline.
 *
 * Vendor scoping: the contact's vendor is what governs the monthly cap;
 * we pass it through props from the conversation context.
 */

interface Props {
  conversationId: string;
  vendorId: string;
  /** Optional draft (for Suggest Reply). */
  draft?: string;
  locale?: string;
  /** Called when Suggest Reply produces text; lets the parent paste it into the composer. */
  onReplySuggested?: (reply: string) => void;
}

function fmtErr(err: unknown): string {
  const e = err as AiError;
  if (e?.code === 'feature_disabled') return 'Disabled by admin.';
  if (e?.code === 'monthly_cap_reached') return 'Monthly AI budget reached.';
  if (e?.code === 'rate_limited') {
    const s = e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : 0;
    return s ? `Rate limited. Retry in ${s}s.` : 'Rate limited.';
  }
  if (e?.code === 'not_configured') return 'AI provider not configured.';
  if (e?.code === 'conversation_not_found') return 'Conversation not found.';
  return e?.message ?? 'Failed.';
}

export function AiPanel({ conversationId, vendorId, draft, locale, onReplySuggested }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const caller = { userId: user?.id ?? '', vendorId };

  type ResultKey = 'summary' | 'reply' | 'sentiment' | 'intent' | 'entities' | 'lead';
  const [active, setActive] = useState<ResultKey | null>(null);

  const summarize = useMutation({
    mutationFn: () => ai.summarize(caller, conversationId),
    onSuccess: () => setActive('summary'),
  });
  const suggestReply = useMutation({
    mutationFn: () => ai.suggestReply(caller, conversationId, { draft, locale }),
    onSuccess: (data) => {
      setActive('reply');
      onReplySuggested?.(data.reply);
    },
  });
  const sentiment = useMutation({
    mutationFn: () => ai.sentiment(caller, conversationId),
    onSuccess: () => setActive('sentiment'),
  });
  const intent = useMutation({
    mutationFn: () => ai.intent(caller, conversationId),
    onSuccess: () => setActive('intent'),
  });
  const entities = useMutation({
    mutationFn: () => ai.entities(caller, conversationId),
    onSuccess: () => setActive('entities'),
  });
  const scoreLead = useMutation({
    mutationFn: () => ai.scoreLead(caller, conversationId),
    onSuccess: () => setActive('lead'),
  });

  const actions: Array<{
    key: ResultKey | 'search';
    label: string;
    busy: boolean;
    run: () => void;
  }> = [
    {
      key: 'summary',
      label: t('ai.action.summarize', { defaultValue: 'Summarize' }),
      busy: summarize.isPending,
      run: () => summarize.mutate(),
    },
    {
      key: 'reply',
      label: t('ai.action.suggestReply', { defaultValue: 'Suggest reply' }),
      busy: suggestReply.isPending,
      run: () => suggestReply.mutate(),
    },
    {
      key: 'sentiment',
      label: t('ai.action.sentiment', { defaultValue: 'Sentiment' }),
      busy: sentiment.isPending,
      run: () => sentiment.mutate(),
    },
    {
      key: 'intent',
      label: t('ai.action.intent', { defaultValue: 'Intent' }),
      busy: intent.isPending,
      run: () => intent.mutate(),
    },
    {
      key: 'entities',
      label: t('ai.action.entities', { defaultValue: 'Entities' }),
      busy: entities.isPending,
      run: () => entities.mutate(),
    },
    {
      key: 'lead',
      label: t('ai.action.scoreLead', { defaultValue: 'Score lead' }),
      busy: scoreLead.isPending,
      run: () => scoreLead.mutate(),
    },
  ];

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('ai.title', { defaultValue: 'AI assistance' })}
        </h3>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <Button
            key={a.key}
            type="button"
            variant="outline"
            size="sm"
            loading={a.busy}
            onClick={a.run}
          >
            {a.label}
          </Button>
        ))}
      </div>

      {/* Results — one panel per action; whichever was last successful is shown */}
      {active === 'summary' && summarize.data && (
        <ResultCard label={t('ai.action.summarize', { defaultValue: 'Summarize' })}>
          <p className="text-sm leading-relaxed text-foreground">{summarize.data.summary}</p>
        </ResultCard>
      )}
      {active === 'reply' && suggestReply.data && (
        <ResultCard label={t('ai.action.suggestReply', { defaultValue: 'Suggest reply' })}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {suggestReply.data.reply}
          </p>
        </ResultCard>
      )}
      {active === 'sentiment' && sentiment.data && (
        <ResultCard label={t('ai.action.sentiment', { defaultValue: 'Sentiment' })}>
          <div className="flex items-baseline gap-3">
            <Pill
              tone={
                sentiment.data.label === 'positive'
                  ? 'success'
                  : sentiment.data.label === 'negative'
                    ? 'destructive'
                    : 'neutral'
              }
            >
              {sentiment.data.label}
            </Pill>
            <span className="text-xs text-muted-foreground tabular-nums">
              score: {sentiment.data.score.toFixed(2)}
            </span>
          </div>
        </ResultCard>
      )}
      {active === 'intent' && intent.data && (
        <ResultCard label={t('ai.action.intent', { defaultValue: 'Intent' })}>
          <div className="flex items-baseline gap-3">
            <Pill tone="primary">{intent.data.intent}</Pill>
            <span className="text-xs text-muted-foreground tabular-nums">
              confidence: {intent.data.confidence.toFixed(2)}
            </span>
          </div>
        </ResultCard>
      )}
      {active === 'entities' && entities.data && (
        <ResultCard label={t('ai.action.entities', { defaultValue: 'Entities' })}>
          {entities.data.entities.length === 0 ? (
            <p className="text-xs text-muted-foreground">No entities detected.</p>
          ) : (
            <ul className="space-y-1.5">
              {entities.data.entities.map((e, i) => (
                <li key={i} className="flex items-baseline gap-2 text-sm">
                  <Pill tone="muted" size="sm">
                    {e.type}
                  </Pill>
                  <span className="text-foreground">{e.value}</span>
                </li>
              ))}
            </ul>
          )}
        </ResultCard>
      )}
      {active === 'lead' && scoreLead.data && (
        <ResultCard label={t('ai.action.scoreLead', { defaultValue: 'Score lead' })}>
          <div className="space-y-2">
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                {scoreLead.data.score}
              </span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
            {scoreLead.data.signals.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {scoreLead.data.signals.map((s, i) => (
                  <li key={i}>
                    <Pill tone="muted" size="sm">
                      {s}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ResultCard>
      )}

      {/* Errors — show last failed mutation */}
      {[summarize, suggestReply, sentiment, intent, entities, scoreLead]
        .filter((m) => m.isError)
        .slice(-1)
        .map((m, i) => (
          <p
            key={i}
            className={cn(
              'flex items-center gap-2 rounded-xl bg-destructive/10 ring-1 ring-destructive/20 px-3 py-2',
              'text-xs text-destructive',
            )}
          >
            <span aria-hidden>•</span> {fmtErr(m.error)}
          </p>
        ))}

      {[summarize, suggestReply, sentiment, intent, entities, scoreLead].some(
        (m) => m.isPending,
      ) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {t('ai.running', { defaultValue: 'Working…' })}
        </div>
      )}
    </div>
  );
}

function ResultCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-secondary/40 px-4 py-3 space-y-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
