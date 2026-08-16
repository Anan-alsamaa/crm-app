import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, cn, Drawer, FormField, Pill, Spinner, Textarea } from '@yiji/ui';
import { HELP_HISTORY_MAX_TURNS, type HelpAssistantTurn } from '@yiji/shared-types';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * In-app AI help assistant — "how do I…?" / "why is X happening?" about THIS
 * CRM, answered in a sentence or two.
 *
 * A CONTINUOUS CHAT, SCOPED TO THE SESSION. The transcript lives in component
 * state and the recent turns ride along with each question, so "and what about
 * the one I just asked?" resolves instead of being refused as off-topic. It was
 * single-shot until 2026-07-29; that made every follow-up a dead end.
 *
 * Nothing is persisted: no thread id, no server-side storage, and `close()`
 * drops the transcript, so reopening starts clean and staff questions are never
 * stored. Staying in scope is NOT a function of forgetting — the gateway's
 * system prompt re-judges each question and fences replayed turns as untrusted
 * data, so this remains a product help box, not a general chatbot.
 */

/** One exchange in the panel. Mirrors HelpAssistantTurn plus the scope flag. */
type Turn = {
  role: 'user' | 'assistant';
  content: string;
  offTopic?: boolean;
  /** Locally seeded greeting. Shown like a message, never sent as history —
   *  replaying our own copy back to the model wastes tokens and teaches it
   *  nothing about what the user actually asked. */
  welcome?: boolean;
};

/* Starter prompts for the empty state. Grounded in things this product really
 * does (the gateway refuses anything else), so a first click never produces a
 * refusal — the worst possible first impression for a help assistant. */
const STARTERS: Array<{ key: string; text: string }> = [
  { key: 'reassign', text: 'How do I reassign a ticket to another agent?' },
  { key: 'sla', text: 'How is the first-response SLA clock stopped?' },
  { key: 'import', text: 'How do I import contacts from a CSV?' },
  { key: 'team', text: 'How do I add an agent to a team?' },
];

const MAX_LENGTH = 500;
const MIN_LENGTH = 3;

/* House-style glyph (24x24, 1.75 stroke, currentColor) — @yiji/ui ships no
 * help icon, so it stays local like the AI-config page glyphs. */

export function HelpAssistant(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const firstName = user?.first_name?.trim() || t('helpAssistant.there', { defaultValue: 'there' });
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  /** This session's transcript, oldest first. Never leaves the component. */
  const [turns, setTurns] = useState<Turn[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const caller = { userId: user?.id ?? '' };
  /**
   * History is passed as a mutation VARIABLE, not read from `turns` inside
   * mutationFn. react-query resolves mutationFn from the latest render, so a
   * closure over `turns` picked up the user turn we had only just appended —
   * the current question ended up inside its own history and was sent twice.
   * Capturing it at call time in submit() keeps the two unambiguous.
   */
  const ask = useMutation({
    mutationFn: (v: { question: string; history: HelpAssistantTurn[] }) =>
      ai.helpAssistant(caller, v.question, v.history),
    onSuccess: (res) =>
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: res.answer, offTopic: res.offTopic },
      ]),
  });

  const trimmed = question.trim();
  const canSend = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH;

  const close = () => {
    setOpen(false);
    // Session-scoped: drop the whole transcript so reopening starts clean and
    // nothing staff asked survives the panel.
    setQuestion('');
    setTurns([]);
    ask.reset();
  };

  /** Send an arbitrary question — used by both the composer and the chips. */
  const send = (raw: string) => {
    const asked = raw.trim();
    if (asked.length < MIN_LENGTH || asked.length > MAX_LENGTH || ask.isPending) return;
    // Snapshot the transcript BEFORE adding this question, so it never appears
    // in its own history. Only the most recent turns ride along: enough to
    // resolve "that one", bounded so a long session cannot grow the prompt (and
    // the bill) without limit. The server caps this again rather than trusting us.
    const history = turns
      .filter((t2) => !t2.welcome)
      .slice(-HELP_HISTORY_MAX_TURNS)
      .map(({ role, content }) => ({ role, content }));
    // Show the question immediately; the answer lands when the request settles.
    setTurns((prev) => [...prev, { role: 'user', content: asked }]);
    setQuestion('');
    ask.mutate({ question: asked, history });
  };

  const submit = () => send(question);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    // Optional-call: jsdom (and some embedded webviews) do not implement
    // scrollIntoView, and an auto-scroll must never break the panel.
    feedRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [turns, ask.isPending]);

  /** Every gateway failure gets its own sentence — never a bare "error". */
  const errorMessage = (): string => {
    const e = ask.error as AiError | null;
    if (!e) return '';
    if (e.code === 'feature_disabled')
      return t('helpAssistant.error.disabled', {
        defaultValue: 'AI help is turned off by your administrator.',
      });
    if (e.code === 'quota_exceeded') {
      const reset = e.resetAt ? new Date(e.resetAt) : null;
      const at =
        reset && !Number.isNaN(reset.getTime())
          ? reset.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : t('helpAssistant.error.quotaResetUnknown', { defaultValue: 'tomorrow' });
      return t('helpAssistant.error.quota', {
        defaultValue:
          'You’ve used your daily AI help allowance ({{limit}}). It resets at {{time}}.',
        limit: e.limit ?? 0,
        time: at,
      });
    }
    if (e.code === 'rate_limited')
      return t('helpAssistant.error.rateLimited', {
        defaultValue: 'Too many requests — try again in {{seconds}}s.',
        seconds: Math.max(1, Math.ceil((e.retryAfterMs ?? 0) / 1000)),
      });
    if (e.status === 503)
      return t('helpAssistant.error.notConfigured', {
        defaultValue: 'AI help isn’t configured yet.',
      });
    if (e.code === 'invalid_body')
      return t('helpAssistant.error.invalid', {
        defaultValue: 'Ask a question between 3 and 500 characters.',
      });
    return t('helpAssistant.error.generic', {
      defaultValue: 'Couldn’t get an answer. Please try again.',
    });
  };

  const launchLabel = t('helpAssistant.launch', { defaultValue: 'Ask AI help' });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Open on a greeting rather than an empty box: the panel should read
          // as a conversation already in progress, not a form to fill in.
          setTurns((prev) =>
            prev.length
              ? prev
              : [
                  {
                    role: 'assistant',
                    welcome: true,
                    content: t('helpAssistant.welcome', {
                      defaultValue:
                        'Hi {{name}}, I am Aura. I know this CRM inside out — the inbox, tickets, SLA, reports, contacts, automation and the widget. What are we solving?',
                      name: firstName,
                    }),
                  },
                ],
          );
        }}
        aria-label={launchLabel}
        title={launchLabel}
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-full px-3',
          'text-2xs font-bold uppercase tracking-[0.1em]',
          'transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'bg-primary/12 text-primary hover:bg-primary/20',
        )}
      >
        AI
      </button>

      <Drawer
        open={open}
        onClose={close}
        width="md"
        title={t('helpAssistant.title2', { defaultValue: 'Aura' })}
        description={t('helpAssistant.description', {
          defaultValue:
            'Your assistant for this CRM. Ask how anything works — follow-ups keep their context, and nothing is saved when you close this panel.',
        })}
        // The composer belongs in the STICKY footer, not the scrolling body:
        // trailing the last reply meant it drifted off-screen exactly when the
        // conversation got long enough to want another question.
        footer={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="w-full space-y-3"
          >
            <FormField
              label={t('helpAssistant.label', { defaultValue: 'Your question' })}
              htmlFor="help-assistant-question"
            >
              <Textarea
                id="help-assistant-question"
                rows={3}
                maxLength={MAX_LENGTH}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Chat convention: Enter sends, Shift+Enter newlines.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={t('helpAssistant.placeholder', {
                  defaultValue: 'How do I add an agent to a team?',
                })}
              />
            </FormField>

            <div className="flex items-center justify-between gap-3">
              <span
                aria-live="polite"
                className="text-2xs tabular-nums text-muted-foreground"
                data-testid="help-assistant-counter"
              >
                {/* `chars`, not `count` — `count` is i18next's plural selector. */}
                {t('helpAssistant.counter', {
                  defaultValue: '{{chars}}/{{max}}',
                  chars: question.length,
                  max: MAX_LENGTH,
                })}
              </span>
              <Button type="submit" size="sm" disabled={!canSend} loading={ask.isPending}>
                {t('helpAssistant.send', { defaultValue: 'Ask' })}
              </Button>
            </div>
          </form>
        }
      >
        {/* Transcript — this session only, cleared when the panel closes. */}
        <div className="space-y-3" aria-live="polite">
          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-ee-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
                  {turn.content}
                </p>
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1.5">
                {/* Off-topic replies are shown but visually demoted, so nobody
                    mistakes a refusal for guidance about this CRM. */}
                {turn.offTopic && (
                  <Pill tone="muted" size="sm">
                    {t('helpAssistant.offTopicTag', { defaultValue: 'Out of scope' })}
                  </Pill>
                )}
                <p
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-es-md px-4 py-2.5 text-sm leading-relaxed ring-1 ring-foreground/[0.06]',
                    turn.offTopic
                      ? 'bg-secondary text-muted-foreground'
                      : 'bg-bubble text-foreground',
                  )}
                >
                  {turn.content}
                </p>
              </div>
            ),
          )}

          {turns.length === 1 && turns[0]?.welcome && !ask.isPending && (
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('helpAssistant.tryAsking', { defaultValue: 'Try asking' })}
              </p>
              {STARTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() =>
                    send(t(`helpAssistant.starter.${s.key}`, { defaultValue: s.text }))
                  }
                  className="group flex w-full items-center justify-between gap-3 rounded-xl bg-primary/10 px-4 py-2.5 text-start text-sm font-medium text-foreground ring-1 ring-primary/20 transition-all duration-fast ease-out hover:bg-primary hover:text-primary-foreground hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span>{t(`helpAssistant.starter.${s.key}`, { defaultValue: s.text })}</span>
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5 shrink-0 opacity-40 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  >
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </button>
              ))}
            </div>
          )}
          {ask.isPending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> {t('helpAssistant.thinking', { defaultValue: 'Looking that up…' })}
            </div>
          )}

          {ask.isError && (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-xs leading-relaxed text-destructive ring-1 ring-destructive/20"
            >
              {errorMessage()}
            </p>
          )}

          {/* Scroll anchor — the Drawer body is the scroller, not this div. */}
          <div ref={feedRef} />
        </div>
      </Drawer>
    </>
  );
}
