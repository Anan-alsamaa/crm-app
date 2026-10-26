import type { JSX } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  AI_SKIN,
  AuraLauncher,
  AuraPanel,
  Button,
  cn,
  CalendarIcon,
  ShieldIcon,
  TeamIcon,
  ZapIcon,
  toast,
  useWhatsNew,
  type AuraLabels,
  type AuraSuggestion,
} from '@yiji/ui';
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
 *
 * The look (header, empty state, bubbles, composer) is `AuraPanel` in
 * `@yiji/ui`, shared with the agent portal (2026-10-26). This file keeps what
 * is the admin portal's own: the gateway call, the transcript, the wording,
 * and the action card that lets an admin create what Aura proposed.
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

const MAX_LENGTH = 500;
const MIN_LENGTH = 3;

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
    <div className="aura-in w-full max-w-sm rounded-[1.125rem] bg-card p-4 shadow-soft ring-1 ring-primary/20">
      <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-primary">
        {t('helpAssistant.proposal', { defaultValue: 'Aura can set this up' })}
      </p>
      <dl className="mt-3 space-y-2 text-xs">
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
        <p className="mt-3 rounded-xl bg-success-tint px-3 py-2 text-xs font-semibold text-foreground">
          {t('helpAssistant.created', {
            defaultValue: 'Created. Find it under Scheduled reports.',
          })}
        </p>
      ) : (
        <Button
          size="sm"
          className={cn('mt-3 rounded-full px-4', AI_SKIN.accentBtn)}
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
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      {/* `auto`: a cron, an email or a report key set inside Arabic text
          would otherwise be reordered right to left ("1 * * 7 0"). */}
      <dd dir="auto" className="min-w-0 break-words font-semibold text-foreground">
        {value}
      </dd>
    </div>
  );
}

export function HelpAssistant(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const firstName = user?.first_name?.trim() || t('helpAssistant.there', { defaultValue: 'there' });
  const [open, setOpen] = useState(false);
  /** The release tour, when this person has one (null outside its provider). */
  const whatsNew = useWhatsNew();
  /** This session's transcript, oldest first. Never leaves the component. */
  const [turns, setTurns] = useState<Turn[]>([]);

  const caller = { userId: user?.id ?? '' };
  /**
   * History is passed as a mutation VARIABLE, not read from `turns` inside
   * mutationFn. react-query resolves mutationFn from the latest render, so a
   * closure over `turns` picked up the user turn we had only just appended —
   * the current question ended up inside its own history and was sent twice.
   * Capturing it at call time in send() keeps the two unambiguous.
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

  const close = () => {
    setOpen(false);
    // Session-scoped: drop the whole transcript so reopening starts clean and
    // nothing staff asked survives the panel.
    setTurns([]);
    ask.reset();
  };

  /**
   * Send a question — from the composer, a starter card, or a retry.
   * `base` is the transcript to append to: a retry passes it WITHOUT the
   * failed question, so that question is neither shown twice nor replayed as
   * its own history.
   */
  const send = (raw: string, base: Turn[] = turns) => {
    const asked = raw.trim();
    if (asked.length < MIN_LENGTH || asked.length > MAX_LENGTH || ask.isPending) return;
    // Snapshot the transcript BEFORE adding this question, so it never appears
    // in its own history. Only the most recent turns ride along: enough to
    // resolve "that one", bounded so a long session cannot grow the prompt (and
    // the bill) without limit. The server caps this again rather than trusting us.
    const history = base
      .filter((t2) => !t2.welcome)
      .slice(-HELP_HISTORY_MAX_TURNS)
      .map(({ role, content }) => ({ role, content }));
    // Show the question immediately; the answer lands when the request settles.
    setTurns([...base, { role: 'user', content: asked }]);
    ask.mutate({ question: asked, history });
  };

  const retry = () => {
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'user') return;
    ask.reset();
    send(last.content, turns.slice(0, -1));
  };

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
  /* A quota, a switched-off feature or a missing configuration will not be
     fixed by asking again; a blip or a rate limit will. */
  const retryable = (() => {
    const e = ask.error as AiError | null;
    if (!e) return false;
    return (
      !['feature_disabled', 'quota_exceeded', 'invalid_body'].includes(e.code ?? '') &&
      e.status !== 503
    );
  })();

  /* Starter questions for the empty state. Grounded in what the gateway's
     prompt actually documents for administrators (scheduled reports, which
     Aura can also SET UP; automation on an SLA breach; SLA business hours;
     teams), so a first click never produces a refusal or an "I'm not sure".
     Roles and coupon approvals are deliberately absent: the assistant is not
     taught them and would have to guess. */
  const suggestions: AuraSuggestion[] = [
    {
      key: 'schedule',
      icon: <CalendarIcon size={16} />,
      title: t('helpAssistant.starterTitle.schedule', { defaultValue: 'Schedule a report' }),
      prompt: t('helpAssistant.starter.schedule', {
        defaultValue: 'Send the SLA compliance report every Monday at 07:00',
      }),
    },
    {
      key: 'escalate',
      icon: <ZapIcon size={16} />,
      title: t('helpAssistant.starterTitle.escalate', { defaultValue: 'Escalate on breach' }),
      prompt: t('helpAssistant.starter.escalate', {
        defaultValue: 'How do I escalate a ticket automatically when its SLA is breached?',
      }),
    },
    {
      key: 'businessHours',
      icon: <ShieldIcon size={16} />,
      title: t('helpAssistant.starterTitle.businessHours', {
        defaultValue: 'SLA business hours',
      }),
      prompt: t('helpAssistant.starter.businessHours', {
        defaultValue: 'How do I set business hours on an SLA policy?',
      }),
    },
    {
      key: 'team',
      icon: <TeamIcon size={16} />,
      title: t('helpAssistant.starterTitle.team', { defaultValue: 'Build a team' }),
      prompt: t('helpAssistant.starter.team', {
        defaultValue: 'How do I add an agent to a team?',
      }),
    },
  ];

  const labels: AuraLabels = {
    name: t('helpAssistant.title2', { defaultValue: 'Aura' }),
    role: t('helpAssistant.role', { defaultValue: 'CRM assistant' }),
    field: t('helpAssistant.label', { defaultValue: 'Your question' }),
    placeholder: t('helpAssistant.placeholder', { defaultValue: 'Ask Aura anything…' }),
    send: t('helpAssistant.send', { defaultValue: 'Ask' }),
    enterToSend: t('helpAssistant.enterToSend', { defaultValue: 'to send' }),
    newLine: t('helpAssistant.newLine', { defaultValue: 'for a new line' }),
    caveat: t('helpAssistant.caveat', {
      defaultValue: 'Aura can be wrong. Check anything that matters.',
    }),
    // `chars`, not `count` — `count` is i18next's plural selector.
    counter: (chars, max) =>
      t('helpAssistant.counter', { defaultValue: '{{chars}}/{{max}}', chars, max }),
    thinking: t('helpAssistant.thinking', { defaultValue: 'Looking that up…' }),
    offTopic: t('helpAssistant.offTopicTag', { defaultValue: 'Out of scope' }),
    newChat: t('helpAssistant.newChat', { defaultValue: 'Start a new chat' }),
    close: t('actions.close', { ns: 'common', defaultValue: 'Close' }),
    jumpToLatest: t('helpAssistant.jumpToLatest', { defaultValue: 'Jump to the latest message' }),
    tryAsking: t('helpAssistant.tryAsking', { defaultValue: 'Try asking' }),
    copy: t('helpAssistant.copy', { defaultValue: 'Copy' }),
    copied: t('helpAssistant.copied', { defaultValue: 'Copied' }),
    retry: t('helpAssistant.retry', { defaultValue: 'Try again' }),
    privacy: t('helpAssistant.privacy', {
      defaultValue: 'Nothing is saved. The chat clears when you close this panel.',
    }),
    log: t('helpAssistant.log', { defaultValue: 'Conversation with Aura' }),
    whatsNew: t('whatsNew.menu', { defaultValue: 'What’s new' }),
    whatsNewCardTitle: t('helpAssistant.whatsNewCardTitle', {
      defaultValue: 'New in this release',
    }),
    whatsNewCardBody: t('helpAssistant.whatsNewCardBody', {
      defaultValue: 'Take the one-minute tour of what changed',
    }),
  };

  return (
    <>
      <AuraLauncher
        label={t('helpAssistant.launch', { defaultValue: 'Ask AI help' })}
        onClick={() => {
          setOpen(true);
          // Seed Aura's greeting. It is not shown while the empty state is
          // up; once a question is asked it opens the transcript, so the
          // conversation reads as one she started.
          setTurns((prev) =>
            prev.length
              ? prev
              : [
                  {
                    role: 'assistant',
                    welcome: true,
                    content: t('helpAssistant.welcome', {
                      defaultValue:
                        'Hi {{name}}, I am Aura. I know this CRM inside out: the inbox, tickets, SLA, reports, contacts, automation and the widget. What are we solving?',
                      name: firstName,
                    }),
                  },
                ],
          );
        }}
      />

      <AuraPanel<Turn>
        open={open}
        onClose={close}
        onNewChat={() => {
          setTurns([]);
          ask.reset();
        }}
        turns={turns}
        pending={ask.isPending}
        error={ask.isError ? errorMessage() : null}
        onRetry={retryable ? retry : undefined}
        onSend={(q) => send(q)}
        greeting={t('helpAssistant.greeting', {
          defaultValue: 'Hi {{name}}, I’m Aura',
          name: firstName,
        })}
        intro={t('helpAssistant.intro', {
          defaultValue:
            'I know Sara CRM inside out. Ask me how something works, or why something is happening.',
        })}
        suggestions={suggestions}
        onWhatsNew={
          whatsNew?.available
            ? () => {
                // What's new: the way back into this release's tour (owner,
                // 2026-10-25). The panel makes way for it.
                close();
                whatsNew.open();
              }
            : null
        }
        renderExtra={(turn) => (turn.action ? <ActionCard action={turn.action} /> : null)}
        labels={labels}
        minLength={MIN_LENGTH}
        maxLength={MAX_LENGTH}
      />
    </>
  );
}
