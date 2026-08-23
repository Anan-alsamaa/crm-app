import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { AI_SKIN, Button, cn, Pill, Spinner } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { optionsFor, useOptionLists } from '../tickets/option-lists.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * AI panel — the per-conversation actions. Each calls the gateway via a
 * TanStack mutation and renders its result inline.
 *
 * WHICH actions appear is an operations decision, not a deploy: the panel
 * offers what the `ai_action` list in the admin portal has switched on, in the
 * order set there. The catalogue below is the full set the gateway can serve;
 * the list decides which of them an agent sees.
 *
 * Vendor scoping: the contact's vendor is what governs the monthly cap;
 * we pass it through props from the conversation context.
 */

interface Props {
  conversationId: string;
  vendorId: string;
  /** Optional draft (for Suggest Reply). */
  draft?: string;
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

export function AiPanel({ conversationId, vendorId, draft, onReplySuggested, className }: Props) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const caller = { userId: user?.id ?? '', vendorId };

  type ResultKey = 'summary' | 'reply' | 'sentiment' | 'intent' | 'entities';
  /**
   * ONE language for this panel, from two places, with a fixed priority.
   *
   *   1. The selector in this panel, when the agent has used it.
   *   2. Otherwise the portal language.
   *
   * The selector wins. AR here with an English portal means Arabic; EN here
   * with an Arabic portal means English. That is the whole rule, and it is
   * worth stating plainly because the two settings genuinely can disagree and
   * "which one is in charge" is the first thing anyone asks.
   *
   * The chosen language drives BOTH halves of the panel — the buttons and
   * result headings the agent reads, and the language the suggested reply is
   * written in. Splitting them is what made the feature feel broken: the agent
   * picked AR, the draft came back in Arabic, and the buttons that produced it
   * stayed in English.
   */
  const portalLocale: 'en' | 'ar' = (i18n.language ?? 'en').toLowerCase().startsWith('ar')
    ? 'ar'
    : 'en';
  const [chosenLocale, setChosenLocale] = useState<'en' | 'ar' | null>(null);
  const uiLocale: 'en' | 'ar' = chosenLocale ?? portalLocale;
  const setReplyLocale = setChosenLocale;

  const tl = useMemo(
    // Guarded: `getFixedT` is part of a full i18next instance, and a caller
    // that supplies a lighter one should get English labels, not a crash in
    // the middle of a conversation.
    () => (typeof i18n.getFixedT === 'function' ? i18n.getFixedT(uiLocale) : t),
    [i18n, uiLocale, t],
  );
  const [active, setActive] = useState<ResultKey | null>(null);
  const lists = useOptionLists();

  const summarize = useMutation({
    mutationFn: () => ai.summarize(caller, conversationId, uiLocale),
    onSuccess: () => setActive('summary'),
  });
  const suggestReply = useMutation({
    // Always explicit. The gateway treats a stated locale as overriding the
    // language of the thread, which is exactly what is wanted here: the agent
    // (or their portal) has said which language this customer is answered in.
    mutationFn: () => ai.suggestReply(caller, conversationId, { draft, locale: uiLocale }),
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
    // Answer in the vocabulary the ticket form offers, so the result can be
    // used as-is instead of being translated by the agent.
    mutationFn: () => ai.intent(caller, conversationId, optionsFor(lists.data, 'complaint_type')),
    onSuccess: () => setActive('intent'),
  });
  const entities = useMutation({
    mutationFn: () => ai.entities(caller, conversationId, uiLocale),
    onSuccess: () => setActive('entities'),
  });

  /**
   * Everything the gateway can do, in its natural order. What an agent
   * actually sees is this filtered by the `ai_action` list — see below.
   */
  const catalogue: Array<{
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
      label: tl('ai.action.sentiment', { defaultValue: 'Customer mood' }),
      busy: sentiment.isPending,
      run: () => sentiment.mutate(),
    },
    {
      key: 'intent',
      label: tl('ai.action.intent', { defaultValue: 'Ticket type' }),
      busy: intent.isPending,
      run: () => intent.mutate(),
    },
    {
      key: 'entities',
      label: tl('ai.action.entities', { defaultValue: 'Key details' }),
      busy: entities.isPending,
      run: () => entities.mutate(),
    },
  ];

  /**
   * The actions operations have switched on, in the order they set.
   *
   * Driven by the admin portal's `ai_action` list so turning one off is a row
   * edit rather than a release. Two deliberate choices:
   *
   *   - Unknown values are IGNORED rather than rendered. The list is free text,
   *     and a typo must not put a dead button in front of an agent.
   *   - An empty or unreadable list falls back to the whole catalogue, because
   *     a panel with no buttons reads as a broken feature, and the fallback in
   *     `optionsFor` already encodes exactly that intent.
   */
  const byKey = new Map(catalogue.map((a) => [a.key, a]));
  const picked = optionsFor(lists.data, 'ai_action')
    .map((k) => byKey.get(k as ResultKey))
    .filter((a): a is (typeof catalogue)[number] => !!a);
  const actions = picked.length > 0 ? picked : catalogue;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.08]',
        className,
      )}
    >
      {/* Same identity as the Aura drawer — an indigo band with the mark. The
          two AI surfaces used to look like unrelated features; carrying one
          treatment across both is what makes them read as one assistant. */}
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-4 py-2.5',
          AI_SKIN.head,
          AI_SKIN.headText,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-lg', AI_SKIN.headChip)}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
              <path d="M8 1.6 9.4 5.2 13 6.6 9.4 8 8 11.6 6.6 8 3 6.6 6.6 5.2 8 1.6ZM12.6 10.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" />
            </svg>
          </span>
          <h3 className="truncate text-2xs font-bold uppercase tracking-[0.14em]">
            {tl('ai.title', { defaultValue: 'AI assistance' })}
          </h3>
        </span>
        {/* Which language a suggested reply comes back in. Sits by the actions
            rather than in settings: the answer changes per customer, not per
            agent, and a reply drafted in the wrong language is not editable
            into the right one. */}
        <div
          role="group"
          aria-label={tl('ai.replyLanguage', { defaultValue: 'Assistant language' })}
          className="flex shrink-0 overflow-hidden rounded-md ring-1 ring-white/30"
        >
          {(['en', 'ar'] as const).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setReplyLocale(code)}
              // Reflects the EFFECTIVE language, not just an explicit pick, so
              // the control always shows which language the panel is in —
              // including before anyone has touched it.
              aria-pressed={uiLocale === code}
              className={cn(
                'px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide transition-colors duration-fast ease-out',
                uiLocale === code ? 'bg-white text-primary' : 'text-white/75 hover:bg-white/15',
              )}
            >
              {code}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 px-4 py-3.5">
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
          <ResultCard label={tl('ai.action.sentiment', { defaultValue: 'Customer mood' })}>
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
                {/* A closed set of three, so it is translated HERE rather than
                  asked of the model — a label the code branches on must not
                  come back as a different word each time. */}
                {tl(`ai.mood.${sentiment.data.label}`, { defaultValue: sentiment.data.label })}
              </Pill>
              <span className="text-xs text-muted-foreground tabular-nums">
                {tl('ai.score', { defaultValue: 'score' })}: {sentiment.data.score.toFixed(2)}
              </span>
            </div>
          </ResultCard>
        )}
        {active === 'intent' && intent.data && (
          <ResultCard label={tl('ai.action.intent', { defaultValue: 'Ticket type' })}>
            <div className="flex items-baseline gap-3">
              <Pill tone="primary">{intent.data.intent}</Pill>
              <span className="text-xs text-muted-foreground tabular-nums">
                {tl('ai.confidence', { defaultValue: 'confidence' })}:{' '}
                {intent.data.confidence.toFixed(2)}
              </span>
            </div>
          </ResultCard>
        )}
        {active === 'entities' && entities.data && (
          <ResultCard label={tl('ai.action.entities', { defaultValue: 'Key details' })}>
            {entities.data.entities.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tl('ai.noEntities', {
                  defaultValue:
                    'Nothing stated yet — no order number, branch or item in this chat.',
                })}
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
        {/* Errors — show last failed mutation */}
        {[summarize, suggestReply, sentiment, intent, entities]
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

        {[summarize, suggestReply, sentiment, intent, entities].some((m) => m.isPending) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> {tl('ai.running', { defaultValue: 'Working…' })}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-xl border-s-2 border-primary/40 bg-primary-tint/40 px-4 py-3 ring-1 ring-primary/10">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-primary">{label}</div>
      {children}
    </div>
  );
}
