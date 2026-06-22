import type { JSX, SVGProps } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  ClockIcon,
  cn,
  FormField,
  Input,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import type { AiFeatureConfig } from '@yiji/shared-types';
import { aiAdmin } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

type Config = typeof AiFeatureConfig._type;

/*
 * Inline glyphs, matching the @yiji/ui Icon house style (24x24 viewBox,
 * 1.75 stroke, rounded join/cap, currentColor). @yiji/ui doesn't ship an
 * icon for most AI features, so these stay local to this page.
 */
type Glyph = (props: SVGProps<SVGSVGElement>) => JSX.Element;

const glyphBase = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

const SummarizeGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M4 6h16" />
    <path d="M4 11h16" />
    <path d="M4 16h10" />
  </svg>
);
const SuggestReplyGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" />
    <path d="M9.5 11.5h.01" />
    <path d="M13 11.5h.01" />
  </svg>
);
const SentimentGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5s1.4 1.5 3.5 1.5 3.5-1.5 3.5-1.5" />
    <path d="M9 9.5h.01" />
    <path d="M15 9.5h.01" />
  </svg>
);
const IntentGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M12 2v3" />
    <circle cx="12" cy="12" r="7" />
    <path d="M12 12l3.5-2" />
  </svg>
);
const EntitiesGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.4Z" />
    <path d="M7.5 7.5h.01" />
  </svg>
);
const SemanticSearchGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
const ScoreLeadGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M3 17l5-5 3.5 3.5L19 8" />
    <path d="M15 8h4v4" />
  </svg>
);

const FEATURES: Array<{ key: keyof Config; label: string; hint: string; glyph: Glyph }> = [
  {
    key: 'summarize',
    label: 'Summarize conversation',
    hint: 'Three-sentence summary on demand or on close.',
    glyph: SummarizeGlyph,
  },
  {
    key: 'suggestReply',
    label: 'Suggest reply',
    hint: 'Drafts a reply for the agent to refine.',
    glyph: SuggestReplyGlyph,
  },
  {
    key: 'analyzeSentiment',
    label: 'Analyze sentiment',
    hint: 'Classifies the conversation as positive / neutral / negative.',
    glyph: SentimentGlyph,
  },
  {
    key: 'detectIntent',
    label: 'Detect intent',
    hint: 'Tags the customer’s primary intent (refund, shipping, etc.).',
    glyph: IntentGlyph,
  },
  {
    key: 'extractEntities',
    label: 'Extract entities',
    hint: 'Pulls out order IDs, dates, amounts, tracking numbers.',
    glyph: EntitiesGlyph,
  },
  {
    key: 'semanticSearch',
    label: 'Semantic search',
    hint: 'Ranks related conversations by meaning, not keyword.',
    glyph: SemanticSearchGlyph,
  },
  {
    key: 'scoreLead',
    label: 'Score lead',
    hint: 'Estimates lead quality + the signals behind the score.',
    glyph: ScoreLeadGlyph,
  },
];

export function AiConfigPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Config | null>(null);

  const configQuery = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => aiAdmin.getConfig({ userId }),
    enabled: !!userId,
  });
  const usageQuery = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => aiAdmin.getUsage({ userId }),
    enabled: !!userId,
    refetchInterval: 30_000,
  });
  const save = useMutation({
    mutationFn: (next: Partial<Config>) => aiAdmin.putConfig({ userId }, next),
    onSuccess: (data) => {
      qc.setQueryData(['ai-config'], data);
      toast.success(t('aiConfig.saved', { defaultValue: 'AI settings saved.' }));
    },
    onError: () =>
      toast.error(t('aiConfig.saveError', { defaultValue: 'Could not save AI settings.' })),
  });

  useEffect(() => {
    if (configQuery.data && !draft) setDraft(configQuery.data);
  }, [configQuery.data, draft]);

  const dirty =
    !!draft && !!configQuery.data && JSON.stringify(draft) !== JSON.stringify(configQuery.data);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('aiConfig.title', { defaultValue: 'AI assistance' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <span className="opacity-50">·</span>{' '}
          {t('aiConfig.subtitle', {
            defaultValue: 'Toggle features and set a monthly call budget.',
          })}
        </span>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => draft && save.mutate(draft)}
        >
          {t('actions.save', { ns: 'common' })}
        </Button>
      </Toolbar>

      <div className="mx-auto w-full max-w-3xl flex-1 overflow-auto px-6 py-8 space-y-8 sm:px-10">
        {/* Usage card */}
        <section className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex h-6 w-6 items-center justify-center rounded-lg bg-secondary/60 text-muted-foreground ring-1 ring-foreground/[0.04]"
            >
              <ClockIcon size={13} />
            </span>
            <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('aiConfig.usage', { defaultValue: 'This month' })}
            </h2>
          </div>
          {usageQuery.isLoading ? (
            <Skeleton className="mt-3 h-8 w-32" />
          ) : (
            <div className="mt-2 flex items-baseline gap-3 tabular-nums">
              <span className="text-3xl font-semibold tracking-tight text-foreground">
                {usageQuery.data?.used ?? 0}
              </span>
              <span className="text-sm text-muted-foreground">
                {usageQuery.data?.cap
                  ? `/ ${usageQuery.data.cap.toLocaleString()} ${t('aiConfig.calls', { defaultValue: 'calls' })}`
                  : t('aiConfig.unlimited', { defaultValue: 'unlimited' })}
              </span>
            </div>
          )}
        </section>

        {/* Features list */}
        <section className="space-y-3">
          <div className="space-y-1 px-1">
            <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('aiConfig.features', { defaultValue: 'Features' })}
            </h2>
            <p className="text-sm text-foreground/80">
              {t('aiConfig.featuresHint', {
                defaultValue:
                  'Disabled features return a clean error to the caller — no provider hit, no usage charge.',
              })}
            </p>
          </div>

          {configQuery.isLoading || !draft ? (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <li
                  key={i}
                  className="rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-4 py-4"
                >
                  <div className="flex items-start gap-3">
                    <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                    <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FEATURES.map((f) => {
                const enabled = draft[f.key] as boolean;
                const Glyph = f.glyph;
                return (
                  <li
                    key={f.key as string}
                    className={cn(
                      'group flex items-start gap-3.5 rounded-2xl px-4 py-4 transition-colors duration-fast ease-out',
                      enabled
                        ? 'bg-primary-subtle/50 ring-1 ring-primary/25 shadow-sm shadow-foreground/[0.04]'
                        : 'bg-card/60 ring-1 ring-foreground/[0.04]',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-fast ease-out',
                        enabled
                          ? 'bg-primary/15 text-primary ring-1 ring-primary/20'
                          : 'bg-secondary/60 text-muted-foreground ring-1 ring-foreground/[0.04]',
                      )}
                    >
                      <Glyph width={18} height={18} className="shrink-0" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div
                        className={cn(
                          'text-sm font-medium transition-colors duration-fast ease-out',
                          enabled ? 'text-foreground' : 'text-foreground/90',
                        )}
                      >
                        {t(`aiConfig.feature.${String(f.key)}`, { defaultValue: f.label })}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.hint}</p>
                    </div>
                    <Toggle
                      checked={enabled}
                      onChange={(v) => setDraft({ ...draft, [f.key]: v })}
                      label={f.label}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Monthly cap */}
        <section className="space-y-3">
          <div className="space-y-1 px-1">
            <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('aiConfig.budget', { defaultValue: 'Monthly budget' })}
            </h2>
            <p className="text-sm text-foreground/80">
              {t('aiConfig.budgetHint', {
                defaultValue:
                  'Max provider calls per calendar month, across all features. 0 = unlimited.',
              })}
            </p>
          </div>
          <div className="rounded-2xl bg-card/60 shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04] px-5 py-4">
            <FormField
              label={t('aiConfig.cap', { defaultValue: 'Monthly cap' })}
              htmlFor="monthlyCap"
            >
              <Input
                id="monthlyCap"
                type="number"
                min={0}
                step={100}
                value={draft?.monthlyCap ?? 0}
                onChange={(e) =>
                  draft &&
                  setDraft({
                    ...draft,
                    monthlyCap: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                  })
                }
              />
            </FormField>
          </div>
        </section>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        checked ? 'bg-primary' : 'bg-secondary',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow ring-1 ring-foreground/10 transition-transform duration-fast ease-out',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
