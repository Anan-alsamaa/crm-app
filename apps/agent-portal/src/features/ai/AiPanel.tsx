import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  className?: string;
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
  if (e?.code === 'provider_unavailable' || e?.code === 'upstream')
    return 'AI is temporarily busy. Please try again in a moment.';
  if (e?.code === 'conversation_not_found') return 'Conversation not found.';
  return e?.message ?? 'Failed.';
}

export function AiPanel({
  conversationId,
  vendorId,
  draft,
  locale,
  onReplySuggested,
  className,
}: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const caller = { userId: user?.id ?? '', vendorId };

  type ResultKey = 'summary' | 'reply' | 'sentiment' | 'intent' | 'entities' | 'lead' | 'search';
  /**
   * The language of the SUGGESTED REPLY, which is not automatically the
   * language of the portal: an agent working in English still answers an Arabic
   * customer in Arabic, so the toggle has to stay.
   *
   * But it FOLLOWS the portal language until the agent touches it. Switching the
   * whole app to Arabic and then getting English suggestions reads as the
   * feature ignoring you — and an agent who has switched the interface is
   * overwhelmingly about to write Arabic. Once they pick a side here, that
   * choice is theirs and the page language stops overriding it.
   */
  const pageLocale: 'en' | 'ar' = (locale ?? i18n.language ?? 'en').toLowerCase().startsWith('ar')
    ? 'ar'
    : 'en';
  const [chosenLocale, setChosenLocale] = useState<'en' | 'ar' | null>(null);
  const replyLocale = chosenLocale ?? pageLocale;
  const setReplyLocale = setChosenLocale;

  /**
   * The panel speaks the language it is about to write in.
   *
   * `t` follows the portal, which left the toggle half-obeyed: an agent picked
   * AR, the draft came back in Arabic, and the buttons that produced it stayed
   * in English. The toggle is the agent saying "I am working in Arabic now", so
   * this whole panel answers in that language — not just its output.
   *
   * Scoped to the panel deliberately. Nothing outside it changes, because the
   * choice is about this reply, not about the application.
   */
  const tl = useMemo(
    // Guarded: `getFixedT` is part of a full i18next instance, and a caller
    // that supplies a lighter one should get English labels, not a crash in
    // the middle of a conversation.
    () => (typeof i18n.getFixedT === 'function' ? i18n.getFixedT(replyLocale) : t),
    [i18n, replyLocale, t],
  );
  const [active, setActive] = useState<ResultKey | null>(null);
  const [query, setQuery] = useState('');

  const summarize = useMutation({
    mutationFn: () => ai.summarize(caller, conversationId),
    onSuccess: () => setActive('summary'),
  });
  const suggestReply = useMutation({
    mutationFn: () => ai.suggestReply(caller, conversationId, { draft, locale: replyLocale }),
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
  const search = useMutation({
    mutationFn: (q: string) => ai.search(caller, q),
  });

  const actions: Array<{
    key: ResultKey;
    label: string;
    busy: boolean;
    run: () => void;
  }> = [
    {
      key: 'summary',
      label: tl('ai.action.summarize', { defaultValue: 'Summarize' }),
      busy: summarize.isPending,
      run: () => summarize.mutate(),
    },
    {
      key: 'reply',
      label: tl('ai.action.suggestReply', { defaultValue: 'Suggest reply' }),
      busy: suggestReply.isPending,
      run: () => suggestReply.mutate(),
    },
    {
      key: 'sentiment',
      label: tl('ai.action.sentiment', { defaultValue: 'Sentiment' }),
      busy: sentiment.isPending,
      run: () => sentiment.mutate(),
    },
    {
      key: 'intent',
      label: tl('ai.action.intent', { defaultValue: 'Intent' }),
      busy: intent.isPending,
      run: () => intent.mutate(),
    },
    {
      key: 'entities',
      label: tl('ai.action.entities', { defaultValue: 'Entities' }),
      busy: entities.isPending,
      run: () => entities.mutate(),
    },
    {
      key: 'lead',
      label: tl('ai.action.scoreLead', { defaultValue: 'Score lead' }),
      busy: scoreLead.isPending,
      run: () => scoreLead.mutate(),
    },
    {
      key: 'search',
      label: tl('ai.action.search', { defaultValue: 'Search' }),
      busy: search.isPending,
      run: () => setActive('search'),
    },
  ];

  const runSearch = () => {
    const q = query.trim();
    if (q) search.mutate(q);
  };

  return (
    <div
      className={cn(
        'rounded-2xl bg-card/70 px-5 py-4 shadow-soft ring-1 ring-foreground/[0.04] space-y-4',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {tl('ai.title', { defaultValue: 'AI assistance' })}
        </h3>
        {/* Which language a suggested reply comes back in. Sits by the actions
            rather than in settings: the answer changes per customer, not per
            agent, and a reply drafted in the wrong language is not editable
            into the right one. */}
        <div
          role="group"
          aria-label={tl('ai.replyLanguage', { defaultValue: 'Reply language' })}
          className="flex overflow-hidden rounded-md ring-1 ring-border"
        >
          {(['en', 'ar'] as const).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setReplyLocale(code)}
              aria-pressed={replyLocale === code}
              className={cn(
                'px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide transition-colors duration-fast ease-out',
                replyLocale === code
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              {code}
            </button>
          ))}
        </div>
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
        <ResultCard label={tl('ai.action.summarize', { defaultValue: 'Summarize' })}>
          <p className="text-sm leading-relaxed text-foreground">{summarize.data.summary}</p>
        </ResultCard>
      )}
      {active === 'reply' && suggestReply.data && (
        <ResultCard label={tl('ai.action.suggestReply', { defaultValue: 'Suggest reply' })}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {suggestReply.data.reply}
          </p>
        </ResultCard>
      )}
      {active === 'sentiment' && sentiment.data && (
        <ResultCard label={tl('ai.action.sentiment', { defaultValue: 'Sentiment' })}>
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
        <ResultCard label={tl('ai.action.intent', { defaultValue: 'Intent' })}>
          <div className="flex items-baseline gap-3">
            <Pill tone="primary">{intent.data.intent}</Pill>
            <span className="text-xs text-muted-foreground tabular-nums">
              confidence: {intent.data.confidence.toFixed(2)}
            </span>
          </div>
        </ResultCard>
      )}
      {active === 'entities' && entities.data && (
        <ResultCard label={tl('ai.action.entities', { defaultValue: 'Entities' })}>
          {entities.data.entities.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {tl('ai.noEntities', { defaultValue: 'No entities detected.' })}
            </p>
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
        <ResultCard label={tl('ai.action.scoreLead', { defaultValue: 'Score lead' })}>
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

      {active === 'search' && (
        <ResultCard label={tl('ai.action.search', { defaultValue: 'Search' })}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={tl('ai.search.placeholder', { defaultValue: 'Search conversations…' })}
              placeholder={tl('ai.search.placeholder', { defaultValue: 'Search conversations…' })}
              className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start"
            />
            <Button type="submit" size="sm" loading={search.isPending} disabled={!query.trim()}>
              {tl('actions.search', { ns: 'common', defaultValue: 'Search' })}
            </Button>
          </form>
          {search.data &&
            (search.data.results.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tl('ai.search.empty', { defaultValue: 'No matching conversations.' })}
              </p>
            ) : (
              <ul className="space-y-1">
                {search.data.results.map((r) => (
                  <li key={r.conversationId}>
                    <button
                      type="button"
                      onClick={() => navigate(`/?conv=${r.conversationId}`)}
                      className="block w-full rounded-md px-2 py-1.5 text-start transition-colors duration-fast ease-out hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <p className="line-clamp-2 text-xs text-foreground">{r.snippet}</p>
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {(r.score * 100).toFixed(0)}%
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </ResultCard>
      )}

      {/* Errors — show last failed mutation */}
      {[summarize, suggestReply, sentiment, intent, entities, scoreLead, search]
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

      {[summarize, suggestReply, sentiment, intent, entities, scoreLead, search].some(
        (m) => m.isPending,
      ) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {tl('ai.running', { defaultValue: 'Working…' })}
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
