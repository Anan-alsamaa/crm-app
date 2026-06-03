import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
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

const FEATURES: Array<{ key: keyof Config; label: string; hint: string }> = [
  { key: 'summarize', label: 'Summarize conversation', hint: 'Three-sentence summary on demand or on close.' },
  { key: 'suggestReply', label: 'Suggest reply', hint: 'Drafts a reply for the agent to refine.' },
  { key: 'analyzeSentiment', label: 'Analyze sentiment', hint: 'Classifies the conversation as positive / neutral / negative.' },
  { key: 'detectIntent', label: 'Detect intent', hint: 'Tags the customer’s primary intent (refund, shipping, etc.).' },
  { key: 'extractEntities', label: 'Extract entities', hint: 'Pulls out order IDs, dates, amounts, tracking numbers.' },
  { key: 'semanticSearch', label: 'Semantic search', hint: 'Ranks related conversations by meaning, not keyword.' },
  { key: 'scoreLead', label: 'Score lead', hint: 'Estimates lead quality + the signals behind the score.' },
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
    onError: () => toast.error(t('aiConfig.saveError', { defaultValue: 'Could not save AI settings.' })),
  });

  useEffect(() => {
    if (configQuery.data && !draft) setDraft(configQuery.data);
  }, [configQuery.data, draft]);

  const dirty = !!draft && !!configQuery.data && JSON.stringify(draft) !== JSON.stringify(configQuery.data);

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
          <div className="flex items-baseline justify-between">
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
                defaultValue: 'Disabled features return a clean error to the caller — no provider hit, no usage charge.',
              })}
            </p>
          </div>

          {configQuery.isLoading || !draft ? (
            <ul className="rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-5 space-y-3 py-5">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </ul>
          ) : (
            <ul className="rounded-2xl bg-card/60 shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04] divide-y divide-border/40 px-5">
              {FEATURES.map((f) => {
                const enabled = draft[f.key] as boolean;
                return (
                  <li
                    key={f.key as string}
                    className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {t(`aiConfig.feature.${String(f.key)}`, { defaultValue: f.label })}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{f.hint}</p>
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
                defaultValue: 'Max provider calls per calendar month, across all features. 0 = unlimited.',
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
                  setDraft({ ...draft, monthlyCap: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })
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
