import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { AI_SKIN, Button, cn, Drawer, Pill, Textarea, toast } from '@yiji/ui';
import {
  HELP_HISTORY_MAX_TURNS,
  type AuraAction,
  type HelpAssistantTurn,
} from '@yiji/shared-types';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useCreateReport } from '../reports/api.js';

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
  /** A change Aura proposed for this turn, awaiting the admin's confirmation. */
  action?: AuraAction | null;
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

/**
 * A change Aura proposed, shown in full before anything happens.
 *
 * The assistant never writes: it describes, and the admin presses the button,
 * so the write runs under THEIR session and THEIR permissions. That also means
 * a misread request produces a wrong card — which is visible and free — rather
 * than a wrong record.
 */
function ActionCard({ action }: { action: AuraAction }) {
  const { t } = useTranslation();
  const create = useCreateReport();
  const [done, setDone] = useState(false);

  if (action.kind !== 'create_scheduled_report') return null;
  const { name, type } = action.payload;
  const cron = action.payload.cron ?? '';
  const recipients = action.payload.recipients ?? [];

  return (
    <div className="mt-2 max-w-[85%] rounded-2xl bg-primary/[0.06] p-4 ring-1 ring-inset ring-primary/20">
      <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-primary">
        {t('helpAssistant.proposal', { defaultValue: 'Aura can set this up' })}
      </p>
      <dl className="mt-2.5 space-y-1.5 text-xs">
        <Row label={t('helpAssistant.fieldName', { defaultValue: 'Name' })} value={name} />
        <Row label={t('helpAssistant.fieldType', { defaultValue: 'Report' })} value={type} />
        <Row
          label={t('helpAssistant.fieldFrequency', { defaultValue: 'How often' })}
          value={cron || t('helpAssistant.freqManual', { defaultValue: 'On demand only' })}
        />
        <Row
          label={t('helpAssistant.fieldRecipients', { defaultValue: 'Sent to' })}
          value={
            recipients.length
              ? recipients.join(', ')
              : t('helpAssistant.noRecipients', { defaultValue: 'nobody yet' })
          }
        />
      </dl>
      {done ? (
        <p className="mt-3 text-xs font-medium text-success">
          {t('helpAssistant.created', {
            defaultValue: 'Created. Find it under Scheduled reports.',
          })}
        </p>
      ) : (
        <Button
          size="sm"
          className="mt-3"
          loading={create.isPending}
          onClick={() =>
            create
              .mutateAsync({
                name,
                description: null,
                type,
                filters: {},
                schedule: { email: recipients, cron },
              })
              .then(() => setDone(true))
              .catch(() =>
                toast.error(
                  t('helpAssistant.createFailed', { defaultValue: 'Could not create that.' }),
                ),
              )
          }
        >
          {t('helpAssistant.confirm', { defaultValue: 'Create it' })}
        </Button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** Paper-plane send glyph for the composer. */
function SendIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M14 2 7.5 8.5M14 2l-4.2 12-2.3-5.5L2 6.2 14 2Z" />
    </svg>
  );
}

export function HelpAssistant(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const firstName = user?.first_name?.trim() || t('helpAssistant.there', { defaultValue: 'there' });
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  /** This session's transcript, oldest first. Never leaves the component. */
  const [turns, setTurns] = useState<Turn[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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
      ai.helpAssistant(caller, v.question, v.history, i18n?.language),
    onSuccess: (res) =>
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: res.answer, offTopic: res.offTopic, action: res.action },
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

  /*
   * Keep the newest turn in view — WITHOUT scrolling a conversation that has
   * not started.
   *
   * This used to call `scrollIntoView` on an anchor at the very bottom of the
   * feed, on mount, unconditionally. The anchor sits below the greeting and
   * the four starter chips, so opening the panel scrolled the greeting off its
   * own top edge: the first thing anyone saw was Aura's introduction beginning
   * mid-sentence, under a header that had stayed put because it is sticky. The
   * panel looked broken before a word had been typed.
   *
   * Two rules now. Nothing scrolls until there is something to scroll PAST —
   * an opening greeting is the top of the conversation, not the bottom. And
   * once it does, it follows the newest turn only while the reader is already
   * near the bottom: yanking somebody back down while they are reading an
   * earlier answer is the other half of this complaint.
   */
  const [atBottom, setAtBottom] = useState(true);
  const started = turns.some((turn) => !turn.welcome);

  const scrollToEnd = (behavior: ScrollBehavior = 'smooth') => {
    const el = feedRef.current;
    if (!el) return;
    // Assign rather than `scrollTo`: jsdom implements neither `scrollTo` nor
    // smooth behaviour, and an auto-scroll must never take the panel down.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (!started) return;
    if (!atBottom) return;
    scrollToEnd();
    // `atBottom` is read but deliberately NOT a dependency: this effect
    // follows new TURNS. Re-running it the moment somebody scrolls back down
    // would drag them to the end for no reason they asked for.
  }, [turns, ask.isPending, started]);

  /** Within a line or so of the end — close enough to mean "following along". */
  const onFeedScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  /*
   * The composer takes the height of what is in it, up to the CSS max.
   *
   * Reset to `auto` first: scrollHeight never shrinks below the height already
   * set, so without the reset the box grows on every keystroke and never comes
   * back down when the text is deleted.
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [question, open]);

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
          'bg-ink-foreground/10 text-ink-foreground hover:bg-ink-foreground/20',
        )}
      >
        AI
      </button>

      <Drawer
        open={open}
        onClose={close}
        width="md"
        hideChrome
        panelClassName={AI_SKIN.panel}
        // The composer belongs in the STICKY footer, not the scrolling body:
        // trailing the last reply meant it drifted off-screen exactly when the
        // conversation got long enough to want another question.
        footer={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className={cn('w-full space-y-2 border-t px-5 py-4', AI_SKIN.rule, AI_SKIN.text)}
          >
            {/* No field label: the placeholder says what to do, and a labelled
                form control above a chat composer reads as a form to fill in
                rather than a conversation to continue. The accessible name is
                carried by aria-label instead. */}
            <div className="flex items-end gap-2">
              {/* Grows with what is typed, up to a ceiling.
                  A fixed two-row box wastes half the panel on a five-word
                  question and hides the middle of a long one behind an inner
                  scrollbar — and this is the control people spend the whole
                  session in. */}
              <Textarea
                id="help-assistant-question"
                ref={composerRef}
                aria-label={t('helpAssistant.label', { defaultValue: 'Your question' })}
                className={cn(
                  'max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-2xl border-0',
                  AI_SKIN.field,
                )}
                rows={1}
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
                  defaultValue: 'Ask Aura anything…',
                })}
              />
              {/* Send sits INSIDE the composer row, as a square beside the box
                  rather than a labelled button on a line of its own. */}
              <Button
                type="submit"
                size="sm"
                className={cn('h-10 w-10 shrink-0 rounded-2xl p-0', AI_SKIN.accentBtn)}
                disabled={!canSend}
                loading={ask.isPending}
                aria-label={t('helpAssistant.send', { defaultValue: 'Ask' })}
              >
                <SendIcon />
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              {/* The caveat belongs under the box the answer comes from, not in
                  a help page nobody opens. */}
              <span className={cn('text-2xs', AI_SKIN.accent)}>
                {t('helpAssistant.caveat', {
                  defaultValue: 'Aura can be wrong — check anything that matters.',
                })}
              </span>
              <span
                aria-live="polite"
                className={cn('shrink-0 text-2xs tabular-nums', AI_SKIN.dim)}
                data-testid="help-assistant-counter"
              >
                {/* `chars`, not `count` — `count` is i18next's plural selector. */}
                {t('helpAssistant.counter', {
                  defaultValue: '{{chars}}/{{max}}',
                  chars: question.length,
                  max: MAX_LENGTH,
                })}
              </span>
            </div>
          </form>
        }
      >
        {/* A real column: header that does not move, transcript that scrolls,
            composer in the drawer's own footer.
            The header used to be `sticky top-0` inside the drawer's scroller,
            which works right up until something scrolls the body — and then
            the header stays while the first message slides under it. Owning
            the scroller instead means the transcript is the only thing that
            can move, and this component can say where it should be. */}
        <div className="flex h-full min-h-0 flex-col">
          {/* The panel's own chrome, since the drawer's is suppressed. */}
          <div className={cn('z-10 flex shrink-0 items-center gap-3 px-5 py-3.5', AI_SKIN.head)}>
            <span
              aria-hidden
              className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-xl',
                AI_SKIN.headChip,
              )}
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M8 1.6 9.4 5.2 13 6.6 9.4 8 8 11.6 6.6 8 3 6.6 6.6 5.2 8 1.6ZM12.6 10.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" />
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-sm font-bold tracking-tight', AI_SKIN.headText)}>
                Aura
              </span>
              <span
                className={cn(
                  'block text-2xs font-medium uppercase tracking-[0.12em]',
                  AI_SKIN.headDim,
                )}
              >
                {t('helpAssistant.role', { defaultValue: 'CRM assistant' })}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setTurns([])}
              aria-label={t('helpAssistant.newChat', { defaultValue: 'Start a new chat' })}
              title={t('helpAssistant.newChat', { defaultValue: 'Start a new chat' })}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-lg transition-colors duration-fast',
                AI_SKIN.headHover,
                AI_SKIN.headDim,
              )}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-4 w-4"
                aria-hidden
              >
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-lg transition-colors duration-fast',
                AI_SKIN.headHover,
                AI_SKIN.headDim,
              )}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-4 w-4"
                aria-hidden
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          {/* Transcript — this session only, cleared when the panel closes.
            Aura on the left under her name, the user on the right: the
            arrangement every messaging app uses, so who said what is readable
            without reading. */}
          <div
            ref={feedRef}
            onScroll={onFeedScroll}
            className={cn(
              'relative flex flex-1 flex-col space-y-4 overflow-y-auto overscroll-contain px-5 py-4',
              /* Bottom-anchored via an AUTO MARGIN on the first message,
                 not `justify-end`.
                 `justify-content: flex-end` on a scroll container overflows
                 past its START edge, and content that overflows the start edge
                 of a flex container is not reachable by scrolling — the
                 browser reports scrollHeight === clientHeight and there is
                 nothing to scroll to. Measured here: three exchanges deep, the
                 first reply was cut off under the header with no way back to
                 it. That is the "cannot scroll up" this panel was reported for.
                 An auto margin gives the same look — messages sit at the foot
                 of the panel while the conversation is short — and resolves to
                 zero the moment content exceeds the box, so scrolling works
                 normally. NOT applied to the opening state: with only the
                 greeting present it would drop Aura's welcome and her starter
                 questions to the floor of a tall empty rectangle. */
              started && '[&>*:first-child]:mt-auto',
            )}
            aria-live="polite"
          >
            {turns.map((turn, i) =>
              turn.role === 'user' ? (
                <div key={i} className="flex flex-col items-end gap-1">
                  <span className={cn('pe-1 text-2xs font-medium', AI_SKIN.dim)}>
                    {t('helpAssistant.you', { defaultValue: 'You' })}
                  </span>
                  <p
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-ee-md px-4 py-2.5 text-sm leading-relaxed',
                      AI_SKIN.userBubble,
                    )}
                  >
                    {turn.content}
                  </p>
                </div>
              ) : (
                <div key={i} className="flex flex-col items-start gap-1">
                  <div className="flex items-center gap-1.5 ps-1">
                    <span
                      aria-hidden
                      className="grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground"
                    >
                      A
                    </span>
                    <span className={cn('text-2xs font-medium', AI_SKIN.dim)}>Aura</span>
                    {/* Off-topic replies are labelled but not hidden, so nobody
                      mistakes a refusal for guidance about this CRM. */}
                    {turn.offTopic && (
                      <Pill tone="muted" size="sm">
                        {t('helpAssistant.offTopicTag', { defaultValue: 'Out of scope' })}
                      </Pill>
                    )}
                  </div>
                  <p
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-es-md px-4 py-2.5 text-sm leading-relaxed',
                      turn.offTopic
                        ? cn('bg-secondary ring-1 ring-foreground/[0.06]', AI_SKIN.dim)
                        : cn(AI_SKIN.bubble, AI_SKIN.text, 'border-s-2 border-primary/40'),
                    )}
                  >
                    {turn.content}
                  </p>
                  {turn.action && <ActionCard action={turn.action} />}
                </div>
              ),
            )}

            {turns.length === 1 && turns[0]?.welcome && !ask.isPending && (
              <div className="pt-1">
                <p
                  className={cn('text-2xs font-semibold uppercase tracking-[0.12em]', AI_SKIN.dim)}
                >
                  {t('helpAssistant.tryAsking', { defaultValue: 'Try asking' })}
                </p>
                {/* Two a row, as in the agent portal. Four full-width bars are
                    one repeated shape filling the panel — 200px of suggestions
                    under a greeting nobody has finished reading, which is the
                    other half of why opening this felt like it had already
                    gone wrong. */}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {STARTERS.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() =>
                        send(t(`helpAssistant.starter.${s.key}`, { defaultValue: s.text }))
                      }
                      className={cn(
                        'group flex h-full w-full flex-col justify-between gap-2 rounded-xl p-3',
                        'text-start text-xs font-medium leading-snug transition-all duration-fast ease-out',
                        'motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                        AI_SKIN.glass,
                        AI_SKIN.text,
                      )}
                    >
                      <span>{t(`helpAssistant.starter.${s.key}`, { defaultValue: s.text })}</span>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-3.5 w-3.5 shrink-0 self-end opacity-40 transition-opacity group-hover:opacity-100"
                        aria-hidden
                      >
                        <path d="M6 3l5 5-5 5" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {ask.isPending && (
              /* A BUBBLE on Aura's side, where her answer is about to appear —
               not a spinner and a line of grey text floating in the margin.
               The wait reads as "she is replying" instead of "the panel is
               busy", and the answer lands in the space already reserved for
               it rather than shoving the layout down. */
              <div className="flex flex-col items-start gap-1">
                <div className="flex items-center gap-1.5 ps-1">
                  <span
                    aria-hidden
                    className="grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground"
                  >
                    A
                  </span>
                  <span className={cn('text-2xs font-medium', AI_SKIN.dim)}>Aura</span>
                </div>
                <div
                  className={cn(
                    'flex items-center gap-1.5 rounded-2xl rounded-es-md px-4 py-3.5',
                    AI_SKIN.bubble,
                  )}
                >
                  <span className="sr-only">
                    {t('helpAssistant.thinking', { defaultValue: 'Looking that up…' })}
                  </span>
                  {/* Three dots, staggered. `motion-safe` because a looping
                    animation is exactly what a reduced-motion setting is for. */}
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      aria-hidden
                      style={{ animationDelay: `${i * 160}ms` }}
                      className="h-1.5 w-1.5 rounded-full bg-primary/50 motion-safe:animate-pulse"
                    />
                  ))}
                </div>
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
          </div>

          {/* Jump back to the newest turn.
            Only while there IS a newest turn you cannot see: an always-present
            button is one more thing on a small panel, and one that does
            nothing most of the time. */}
          {started && !atBottom && (
            <div className="pointer-events-none relative">
              <button
                type="button"
                onClick={() => {
                  setAtBottom(true);
                  scrollToEnd();
                }}
                className={cn(
                  'pointer-events-auto absolute -top-12 end-4 grid h-9 w-9 place-items-center rounded-full',
                  'shadow-float transition-transform duration-fast ease-out motion-safe:hover:scale-105',
                  AI_SKIN.accentBg,
                )}
                aria-label={t('helpAssistant.jumpToLatest', {
                  defaultValue: 'Jump to the latest message',
                })}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}
