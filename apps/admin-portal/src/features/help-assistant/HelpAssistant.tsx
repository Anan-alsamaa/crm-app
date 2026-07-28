import type { JSX, SVGProps } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, cn, Drawer, FormField, Pill, Spinner, Textarea } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * In-app AI help assistant — "how do I…?" / "why is X happening?" about THIS
 * CRM, answered in a sentence or two.
 *
 * STATELESS BY DESIGN: one question in, one answer out. There is deliberately
 * no thread, no history and no follow-up context — closing the panel throws
 * the exchange away. This is what keeps it a *help lookup* affordance instead
 * of drifting into a general-purpose chatbot (which is out of scope, costs
 * tokens per turn, and would need retention/PII handling we do not want here).
 * Please don't add a message list.
 */

const MAX_LENGTH = 500;
const MIN_LENGTH = 3;

/* House-style glyph (24x24, 1.75 stroke, currentColor) — @yiji/ui ships no
 * help icon, so it stays local like the AI-config page glyphs. */
function HelpGlyph(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.7" />
      <path d="M12 16.8h.01" />
    </svg>
  );
}

export function HelpAssistant(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');

  const caller = { userId: user?.id ?? '' };
  const ask = useMutation({
    mutationFn: (q: string) => ai.helpAssistant(caller, q),
  });

  const trimmed = question.trim();
  const canSend = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH;

  const close = () => {
    setOpen(false);
    // Stateless: drop the question and its answer so reopening starts clean.
    setQuestion('');
    ask.reset();
  };

  const submit = () => {
    if (!canSend || ask.isPending) return;
    ask.mutate(trimmed);
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

  const launchLabel = t('helpAssistant.launch', { defaultValue: 'Ask AI help' });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={launchLabel}
        title={launchLabel}
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg',
          'transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <HelpGlyph width={17} height={17} />
      </button>

      <Drawer
        open={open}
        onClose={close}
        width="md"
        title={t('helpAssistant.title', { defaultValue: 'Ask AI help' })}
        description={t('helpAssistant.description', {
          defaultValue:
            'Ask how something works in this CRM and get a short answer. One question at a time — nothing is saved.',
        })}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <FormField
            label={t('helpAssistant.label', { defaultValue: 'Your question' })}
            htmlFor="help-assistant-question"
          >
            <Textarea
              id="help-assistant-question"
              rows={4}
              maxLength={MAX_LENGTH}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
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

        {ask.isSuccess && ask.data && (
          <div className="rounded-2xl bg-card px-4 py-4 shadow-soft ring-1 ring-foreground/[0.06] space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('helpAssistant.answer', { defaultValue: 'Answer' })}
              </span>
              {ask.data.offTopic && (
                <Pill tone="muted" size="sm">
                  {t('helpAssistant.offTopicTag', { defaultValue: 'Out of scope' })}
                </Pill>
              )}
            </div>
            {/* Off-topic answers are still shown, but visually demoted so nobody
                mistakes them for authoritative guidance about this CRM. */}
            {ask.data.offTopic && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('helpAssistant.offTopic', {
                  defaultValue:
                    'That looks outside what this assistant covers — it only answers questions about this CRM.',
                })}
              </p>
            )}
            <p
              className={cn(
                'whitespace-pre-wrap text-sm leading-relaxed',
                ask.data.offTopic ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {ask.data.answer}
            </p>
            <p className="text-2xs text-muted-foreground">
              {t('helpAssistant.statelessNote', {
                defaultValue: 'Answers aren’t saved. Edit the question above to ask another.',
              })}
            </p>
          </div>
        )}
      </Drawer>
    </>
  );
}
