import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, cn, Pill, Spinner } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * AI assistance, arranged around what an AGENT is trying to do — not around
 * what the model can do.
 *
 * It used to be seven equal buttons named after machine-learning tasks:
 * Summarize, Suggest reply, Sentiment, Intent, Entities, Score lead, Search.
 * Three problems with that, and they are the same problem three times:
 *
 *   "Entities", "Intent" and "Score lead" are MODEL vocabulary. An agent
 *   answering a complaint has never wanted to "extract entities", and "score
 *   lead" is a sales idea that means nothing in a complaints CRM — it offered
 *   to rate a customer's purchase potential while they waited for an apology.
 *   Those three are gone from this panel. The endpoints still exist and the
 *   admin console still governs them; what changed is that the agent is no
 *   longer asked to choose between them mid-conversation.
 *
 *   Everything looked equally important, so nothing was. Drafting a reply is
 *   what this panel is FOR — the only action that produces work rather than
 *   information — and it now looks like it.
 *
 *   The rest are not commands, they are QUESTIONS about the conversation
 *   ("what happened here?", "how upset are they?"), so they read as questions
 *   and answer in place.
 *
 * Nothing runs on open. Every call is metered against the vendor's monthly
 * budget, so an insight the agent did not ask for is money spent for them.
 */

interface Props {
  conversationId: string;
  vendorId: string;
  /** Optional draft — the reply is built ON it rather than replacing it blind. */
  draft?: string;
  locale?: string;
  /** Called when a draft is produced; the parent puts it in the composer. */
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

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <path d="M8 1.5 9.3 5 12.5 6.2 9.3 7.5 8 11 6.7 7.5 3.5 6.2 6.7 5 8 1.5ZM12.8 10.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z" />
    </svg>
  );
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

  /**
   * The language of the DRAFTED REPLY, which is not automatically the language
   * of the portal: an agent working in English still answers an Arabic
   * customer in Arabic, so the toggle has to stay.
   *
   * It FOLLOWS the portal language until the agent touches it — switching the
   * whole app to Arabic and still getting English drafts reads as the feature
   * ignoring you. Once they pick a side here, that choice is theirs and the
   * page language stops overriding it.
   */
  const pageLocale: 'en' | 'ar' = (locale ?? i18n.language ?? 'en').toLowerCase().startsWith('ar')
    ? 'ar'
    : 'en';
  const [chosenLocale, setChosenLocale] = useState<'en' | 'ar' | null>(null);
  const replyLocale = chosenLocale ?? pageLocale;
  const setReplyLocale = setChosenLocale;

  /**
   * The panel speaks the language it is about to write in — scoped to this
   * panel only, because the choice is about this reply, not the application.
   */
  const tl = useMemo(
    // Guarded: a caller supplying a lighter i18n instance should get English
    // labels, not a crash in the middle of a conversation.
    () => (typeof i18n.getFixedT === 'function' ? i18n.getFixedT(replyLocale) : t),
    [i18n, replyLocale, t],
  );

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const suggestReply = useMutation({
    mutationFn: () => ai.suggestReply(caller, conversationId, { draft, locale: replyLocale }),
    onSuccess: (data) => onReplySuggested?.(data.reply),
  });
  const summarize = useMutation({ mutationFn: () => ai.summarize(caller, conversationId) });
  const sentiment = useMutation({ mutationFn: () => ai.sentiment(caller, conversationId) });
  const search = useMutation({ mutationFn: (q: string) => ai.search(caller, q) });

  const runSearch = () => {
    const q = query.trim();
    if (q) search.mutate(q);
  };

  const mood = sentiment.data?.label;
  const busy = [suggestReply, summarize, sentiment, search].some((m) => m.isPending);
  const lastError = [suggestReply, summarize, sentiment, search].filter((m) => m.isError).slice(-1);

  return (
    <div
      className={cn(
        'space-y-3 rounded-2xl bg-card/70 px-5 py-4 shadow-soft ring-1 ring-foreground/[0.04]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {tl('ai.title', { defaultValue: 'AI assistance' })}
        </h3>
        {/* Which language the draft comes back in. Sits with the action rather
            than in settings: the answer changes per CUSTOMER, not per agent,
            and a reply drafted in the wrong language is not editable into the
            right one. */}
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

      {/* THE action. Full width and primary because it is the only one here
          that produces work rather than information — everything else tells
          the agent something; this one writes their reply. Its label names
          what will actually happen, which differs once a draft exists. */}
      <Button
        type="button"
        className="w-full justify-center"
        loading={suggestReply.isPending}
        onClick={() => suggestReply.mutate()}
        iconStart={<SparkIcon />}
      >
        {suggestReply.data
          ? tl('ai.action.redraft', { defaultValue: 'Draft again' })
          : draft?.trim()
            ? tl('ai.action.improveDraft', { defaultValue: 'Improve my draft' })
            : tl('ai.action.draftReply', { defaultValue: 'Draft a reply' })}
      </Button>

      {suggestReply.data && (
        /* The draft is already in the composer, so repeating it in full would
           put the same words on screen twice and leave the agent unsure which
           copy they are about to send. Say where it went instead. */
        <p className="flex items-start gap-2 rounded-xl bg-primary/[0.07] px-3 py-2 text-xs leading-relaxed text-foreground">
          <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
          <span>
            {tl('ai.draftPlaced', {
              defaultValue: 'Added to your reply below — read it before you send it.',
            })}
          </span>
        </p>
      )}

      {/* Questions about the conversation, answered in place. Not commands: an
          agent asks "what happened?", they never ask to "summarize". */}
      <div className="divide-y divide-foreground/[0.06] border-t border-foreground/[0.06]">
        <InsightRow
          label={tl('ai.insight.whatHappened', { defaultValue: 'What happened here?' })}
          cta={tl('ai.insight.read', { defaultValue: 'Catch me up' })}
          again={tl('ai.insight.again', { defaultValue: 'Again' })}
          busy={summarize.isPending}
          answered={!!summarize.data}
          onRun={() => summarize.mutate()}
        >
          {summarize.data && (
            <p className="text-sm leading-relaxed text-foreground">{summarize.data.summary}</p>
          )}
        </InsightRow>

        <InsightRow
          label={tl('ai.insight.mood', { defaultValue: 'How is the customer feeling?' })}
          cta={tl('ai.insight.check', { defaultValue: 'Check' })}
          again={tl('ai.insight.again', { defaultValue: 'Again' })}
          busy={sentiment.isPending}
          answered={!!sentiment.data}
          onRun={() => sentiment.mutate()}
        >
          {sentiment.data && (
            <div className="flex items-baseline gap-2.5">
              <Pill
                tone={
                  mood === 'positive' ? 'success' : mood === 'negative' ? 'destructive' : 'neutral'
                }
                dot
              >
                {tl(`ai.mood.${mood}`, { defaultValue: mood })}
              </Pill>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {tl('ai.confidence', {
                  defaultValue: '{{n}}% confident',
                  n: Math.round(sentiment.data.score * 100),
                })}
              </span>
            </div>
          )}
        </InsightRow>
      </div>

      {/* Finding a past case is a different job from answering this one, so it
          stays a quiet link rather than a peer of the draft button. */}
      {!searchOpen ? (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="text-2xs font-semibold text-primary transition-colors duration-fast hover:text-primary-strong"
        >
          {tl('ai.action.findSimilar', { defaultValue: 'Find a similar conversation' })}
        </button>
      ) : (
        <div className="space-y-2">
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
              className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-start text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
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
        </div>
      )}

      {lastError.map((m, i) => (
        <p
          key={i}
          className="flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive ring-1 ring-destructive/20"
        >
          <span aria-hidden>•</span> {fmtErr(m.error)}
        </p>
      ))}

      {busy && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {tl('ai.running', { defaultValue: 'Working…' })}
        </div>
      )}
    </div>
  );
}

/**
 * One question about the conversation. Unanswered it is a row with a quiet
 * verb; answered it keeps its label and puts the answer underneath, so the
 * panel grows into a briefing instead of swapping one result card for another
 * and losing what the agent just read.
 */
function InsightRow({
  label,
  cta,
  again,
  busy,
  answered,
  onRun,
  children,
}: {
  label: string;
  cta: string;
  again: string;
  busy: boolean;
  answered: boolean;
  onRun: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          aria-label={label}
          className="shrink-0 text-2xs font-semibold text-primary transition-colors duration-fast hover:text-primary-strong disabled:opacity-50"
        >
          {busy ? '…' : answered ? again : cta}
        </button>
      </div>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
