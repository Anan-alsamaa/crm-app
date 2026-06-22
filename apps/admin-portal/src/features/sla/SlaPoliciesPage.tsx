import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Skeleton,
  Textarea,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import type { Priority } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

interface SlaPolicy {
  id: string;
  name: string;
  description: string | null;
  applies_to_priority: Priority[];
  first_response_minutes: number;
  resolution_minutes: number;
  warning_threshold_percent: number;
  active: boolean;
}

function useSlaPolicies() {
  return useQuery({
    queryKey: ['sla-policies'],
    queryFn: () =>
      directus.request(
        readItems('sla_policies', {
          fields: [
            'id',
            'name',
            'description',
            'applies_to_priority',
            'first_response_minutes',
            'resolution_minutes',
            'warning_threshold_percent',
            'active',
          ],
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<SlaPolicy[]>,
  });
}

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  first_response_minutes: z.coerce.number().int().positive(),
  resolution_minutes: z.coerce.number().int().positive(),
  warning_threshold_percent: z.coerce.number().int().min(1).max(100),
  applies_to_priority: z.array(z.enum(['low', 'medium', 'high', 'urgent'])).min(1),
  active: z.boolean().default(true),
});
type FormValues = z.infer<typeof schema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  description: '',
  first_response_minutes: 30,
  resolution_minutes: 240,
  warning_threshold_percent: 80,
  applies_to_priority: ['medium'],
  active: true,
};

/** Mirrors the inline create mutation; patches an existing policy by id. */
function useUpdateSlaPolicy(qc: QueryClient) {
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: FormValues }) =>
      directus.request(updateItem('sla_policies', id, values as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sla-policies'] }),
  });
}

export function SlaPoliciesPage() {
  const { t } = useTranslation();
  const policies = useSlaPolicies();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (input: FormValues) => directus.request(createItem('sla_policies', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sla-policies'] }),
  });
  const update = useUpdateSlaPolicy(qc);
  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      directus.request(updateItem('sla_policies', id, { active } as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sla-policies'] }),
  });

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });

  const openCreate = () => {
    setEditingId(null);
    reset(DEFAULT_VALUES);
    setOpen(true);
  };
  const openEdit = (p: SlaPolicy) => {
    setEditingId(p.id);
    reset({
      name: p.name,
      description: p.description ?? '',
      first_response_minutes: p.first_response_minutes,
      resolution_minutes: p.resolution_minutes,
      warning_threshold_percent: p.warning_threshold_percent,
      applies_to_priority: p.applies_to_priority,
      active: p.active,
    });
    setOpen(true);
  };
  const closeDrawer = () => {
    setOpen(false);
    setEditingId(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, values });
        toast.success(t('sla.updated', { defaultValue: 'Policy updated.' }));
      } else {
        await create.mutateAsync(values);
        toast.success(t('sla.created'));
      }
      reset(DEFAULT_VALUES);
      closeDrawer();
    } catch {
      toast.error(
        editingId
          ? t('sla.updateError', { defaultValue: 'Could not update policy.' })
          : t('sla.createError'),
      );
    }
  });

  const list = policies.data ?? [];
  const total = list.length;
  const activeCount = list.filter((p) => p.active).length;
  const avgFirst = total
    ? Math.round(list.reduce((a, p) => a + (p.first_response_minutes ?? 0), 0) / total)
    : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">{t('sla.title')}</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong> policies
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{activeCount}</strong> active
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            avg first reply <strong className="font-semibold text-foreground">{avgFirst}m</strong>
          </span>
        </span>
        <ToolbarSpacer />
        <Button type="button" size="sm" onClick={openCreate} iconStart={<PlusIcon />}>
          {t('sla.create')}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {policies.isError ? (
          <ErrorState
            title={t('sla.loadError', { defaultValue: 'Could not load SLA policies' })}
            message={t('sla.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void policies.refetch()}
          />
        ) : policies.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-3">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-3 w-32" />
                <Skeleton className="ms-auto h-4 w-12" />
              </div>
            ))}
          </div>
        ) : !policies.data || policies.data.length === 0 ? (
          <EmptyState
            title={t('sla.empty')}
            description={t('sla.emptyHint', {
              defaultValue: 'Create your first SLA policy to start tracking response times.',
            })}
            action={
              <Button type="button" onClick={openCreate} iconStart={<PlusIcon />}>
                {t('sla.create')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {policies.data.map((p) => (
              <div
                key={p.id}
                className="group relative flex flex-col gap-4 rounded-2xl bg-card/70 px-5 py-5 shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04] transition-[box-shadow,transform,background-color] duration-fast ease-out hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08] hover:-translate-y-px"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-sm font-semibold tracking-tight text-foreground">
                        {p.name}
                      </h3>
                      {p.active ? (
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                      ) : (
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                        />
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {p.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(p)}>
                      {t('actions.edit', { ns: 'common', defaultValue: 'Edit' })}
                    </Button>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={p.active}
                        onChange={(e) =>
                          void toggleActive.mutateAsync({ id: p.id, active: e.target.checked })
                        }
                        className="h-3.5 w-3.5 rounded-sm border-border-strong bg-input accent-primary"
                        aria-label={t('sla.active')}
                      />
                      <span>{t('sla.active')}</span>
                    </label>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {p.applies_to_priority?.map((pr) => (
                    <span
                      key={pr}
                      className="inline-flex items-center rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-semibold text-[oklch(0.42_0.10_196)]"
                    >
                      {t(`priority.${pr}`, { ns: 'common' })}
                    </span>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-4 pt-1">
                  <div>
                    <div className="text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                      first reply
                    </div>
                    <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                      {p.first_response_minutes}m
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                      resolution
                    </div>
                    <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                      {p.resolution_minutes}m
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                      warn at
                    </div>
                    <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                      {p.warning_threshold_percent}%
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editingId ? t('sla.edit', { defaultValue: 'Edit policy' }) : t('sla.create')}
        description={t('sla.createHint', {
          defaultValue:
            'Each policy maps priorities to deadlines; the worker schedules warnings + breach events automatically.',
        })}
        width="lg"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={closeDrawer}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="create-sla-form" loading={isSubmitting}>
              {editingId
                ? t('actions.save', { ns: 'common', defaultValue: 'Save' })
                : t('sla.create')}
            </Button>
          </>
        }
      >
        <form id="create-sla-form" onSubmit={onSubmit} className="space-y-5" noValidate>
          <DrawerSection
            title={t('sla.sectionIdentity', { defaultValue: 'Policy identity' })}
            description={t('sla.sectionIdentityHint', {
              defaultValue: 'How agents recognise this policy in the admin console.',
            })}
          >
            <FormField label={t('sla.name')} error={errors.name?.message}>
              <Input invalid={!!errors.name} {...register('name')} />
            </FormField>
            <FormField label={t('sla.description')}>
              <Textarea rows={2} {...register('description')} />
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('sla.sectionDeadlines', { defaultValue: 'Deadlines' })}
            description={t('sla.sectionDeadlinesHint', {
              defaultValue:
                'Time targets are in minutes. Warnings fire at the threshold % of each deadline.',
            })}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label={`${t('sla.firstResponse')} (min)`}>
                <Input type="number" {...register('first_response_minutes')} />
              </FormField>
              <FormField label={`${t('sla.resolution')} (min)`}>
                <Input type="number" {...register('resolution_minutes')} />
              </FormField>
              <FormField label={`${t('sla.threshold')} (%)`}>
                <Input type="number" {...register('warning_threshold_percent')} />
              </FormField>
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('sla.sectionPriorities', { defaultValue: 'Applies to priorities' })}
            description={t('sla.sectionPrioritiesHint', {
              defaultValue: 'Tickets with these priorities will be governed by this policy.',
            })}
          >
            <fieldset>
              <div className="flex flex-wrap gap-2">
                {PRIORITIES.map((p) => (
                  <label
                    key={p}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-strong bg-input px-2.5 py-1 text-xs text-foreground transition-colors duration-fast ease-out hover:bg-secondary"
                  >
                    <input
                      type="checkbox"
                      value={p}
                      className="h-3.5 w-3.5 rounded-sm border-border-strong bg-input accent-primary"
                      {...register('applies_to_priority')}
                    />
                    {t(`priority.${p}`, { ns: 'common' })}
                  </label>
                ))}
              </div>
              {errors.applies_to_priority && (
                <span className="mt-1 block text-xs text-destructive">
                  {t('sla.atLeastOnePriority')}
                </span>
              )}
            </fieldset>
          </DrawerSection>
        </form>
      </Drawer>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
