import { useState } from 'react';
import { useForm, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ConfirmDialog,
  cn,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Pill,
  Select,
  Skeleton,
  Textarea,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  businessHoursSummary,
  SLA_WEEKDAYS,
  scopeSpecificity,
  policyGoverns,
  type Priority,
  type SlaBusinessHours,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { optionsWith, useOptionLists } from '../../lib/option-lists.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

interface SlaPolicy {
  id: string;
  name: string;
  description: string | null;
  /** 'ticket' | 'chat' — absent on rows written before the field existed. */
  governs: string | null;
  applies_to_priority: Priority[] | null;
  applies_to_type: string[] | null;
  applies_to_source: string[] | null;
  applies_to_brand: string[] | null;
  first_response_minutes: number;
  resolution_minutes: number;
  warning_threshold_percent: number;
  business_hours: SlaBusinessHours | null;
  active: boolean;
}

const POLICY_FIELDS = [
  'id',
  'name',
  'description',
  'governs',
  'applies_to_priority',
  'applies_to_type',
  'applies_to_source',
  'applies_to_brand',
  'first_response_minutes',
  'resolution_minutes',
  'warning_threshold_percent',
  'business_hours',
  'active',
];

/**
 * Delete a policy.
 *
 * The FK is `ON DELETE SET NULL`, so tickets are detached rather than deleted —
 * which is the safe half. The unsafe half is that a detached ticket silently
 * loses the deadline it was being held to, and nothing on the ticket says why.
 * So the confirmation counts them first and says the number out loud; see
 * `useGovernedTicketCount`.
 *
 * Deactivating is usually the better move and is one checkbox away on the same
 * card — it stops the policy governing anything NEW while leaving the tickets
 * already under it alone. Delete is for a policy that was a mistake.
 */
function useDeleteSlaPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('sla_policies' as never, id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sla-policies'] }),
  });
}

/**
 * How many tickets this policy is currently holding to a deadline.
 *
 * Fetched only when somebody actually reaches for Delete — it is a question
 * nobody asks until then, and asking it for every card on every render would be
 * one request per policy for a number usually nobody reads.
 */
function useGovernedTicketCount(policyId: string | null) {
  return useQuery({
    queryKey: ['sla-policy-tickets', policyId],
    enabled: !!policyId,
    staleTime: 30_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'tickets' as never,
          {
            filter: { sla_policy: { _eq: policyId } },
            fields: ['id'],
            limit: -1,
          } as never,
        ),
      )) as unknown as Array<{ id: string }>;
      return rows.length;
    },
  });
}

function useSlaPolicies() {
  return useQuery({
    queryKey: ['sla-policies'],
    queryFn: () =>
      directus.request(
        readItems('sla_policies', {
          fields: POLICY_FIELDS as never,
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<SlaPolicy[]>,
  });
}

/**
 * Brand names for the coverage picker, fetched only while the drawer is open.
 *
 * NAMES, not ids: the matcher compares against `store_snapshot.brandName`, the
 * value frozen onto the ticket when it was raised. Matching on an id would be
 * tidier and wrong — the snapshot exists precisely so that re-pointing a branch
 * at another brand today does not change what last month's tickets say.
 */
function useBrandNames(enabled: boolean) {
  return useQuery({
    queryKey: ['sla-brand-names'],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems('brands', { limit: -1, fields: ['name'] as never, sort: ['name'] }),
      )) as unknown as Array<{ name: string | null }>;
      return [...new Set((rows ?? []).map((r) => r.name).filter((n): n is string => !!n))];
    },
  });
}

/**
 * A coverage list survives the round trip through unchecked checkboxes.
 *
 * React Hook Form hands back an array when several checkboxes share a name, a
 * bare string when only one option is rendered, and `false` when a lone box is
 * unchecked. Normalising here means the form can be honest about "none
 * selected" rather than writing `false` into a JSON column.
 */
const coverageList = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter(Boolean) : typeof v === 'string' && v ? [v] : []),
  z.array(z.string()),
);

const schema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    governs: z.enum(['ticket', 'chat']).default('ticket'),
    first_response_minutes: z.coerce.number().int().positive(),
    resolution_minutes: z.coerce.number().int().positive(),
    warning_threshold_percent: z.coerce.number().int().min(1).max(100),
    applies_to_priority: coverageList,
    applies_to_type: coverageList,
    applies_to_source: coverageList,
    applies_to_brand: coverageList,
    active: z.boolean().default(true),
  })
  /* A policy that names no coverage governs no tickets — the worker skips it,
   * deliberately (see policyCovers). Five such policies have been sitting
   * active and inert in the compensation clone; the form is where that stops
   * being possible to create by accident. */
  .refine(
    (v) =>
      v.applies_to_priority.length +
        v.applies_to_type.length +
        v.applies_to_source.length +
        v.applies_to_brand.length >
      0,
    { path: ['applies_to_priority'], message: 'coverage' },
  );
type FormValues = z.infer<typeof schema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  description: '',
  governs: 'ticket',
  first_response_minutes: 30,
  resolution_minutes: 240,
  warning_threshold_percent: 80,
  applies_to_priority: ['medium'],
  applies_to_type: [],
  applies_to_source: [],
  applies_to_brand: [],
  active: true,
};

/* ── Working hours ─────────────────────────────────────────────────────── */

interface DayState {
  on: boolean;
  open: string;
  close: string;
}
interface HoursState {
  mode: 'always' | 'business';
  timezone: string;
  days: DayState[];
}

/**
 * Zones offered by name rather than a free-text box.
 *
 * A typo in an IANA name is not rejected anywhere — `Intl.DateTimeFormat`
 * throws deep inside the worker's deadline maths, which lands as a dead sweep
 * rather than as "you spelled Asia/Riyadh wrong".
 */
const TIMEZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Africa/Cairo', 'UTC'];

/** Sun-Thu 09:00-17:00 — the Saudi working week, Friday and Saturday closed. */
const DEFAULT_HOURS: HoursState = {
  mode: 'always',
  timezone: 'Asia/Riyadh',
  days: SLA_WEEKDAYS.map((_, i) => ({ on: i <= 4, open: '09:00', close: '17:00' })),
};

function hoursFromPolicy(bh: SlaBusinessHours | null | undefined): HoursState {
  if (!bh) return { ...DEFAULT_HOURS, days: DEFAULT_HOURS.days.map((d) => ({ ...d })) };
  return {
    mode: 'business',
    timezone: bh.timezone || 'Asia/Riyadh',
    days: SLA_WEEKDAYS.map((_, i) => {
      const w = bh.days?.[String(i)]?.[0];
      return w
        ? { on: true, open: w[0], close: w[1] }
        : { on: false, open: '09:00', close: '17:00' };
    }),
  };
}

function hoursToPolicy(h: HoursState): SlaBusinessHours | null {
  if (h.mode === 'always') return null;
  const days: Record<string, Array<[string, string]>> = {};
  h.days.forEach((d, i) => {
    days[String(i)] = d.on && d.open < d.close ? [[d.open, d.close]] : [];
  });
  return { timezone: h.timezone, days };
}

/**
 * Why this set of hours cannot be saved, or null.
 *
 * Working hours with no open window make `computeDueAt` throw — a deadline
 * that can never be reached. The worker now survives it per-ticket, but a
 * policy that can only ever log errors should not be creatable in the first
 * place.
 */
function hoursProblem(h: HoursState): 'noDays' | 'badWindow' | null {
  if (h.mode === 'always') return null;
  const open = h.days.filter((d) => d.on);
  if (open.length === 0) return 'noDays';
  if (open.some((d) => !(d.open < d.close))) return 'badWindow';
  return null;
}

/** Mirrors the inline create mutation; patches an existing policy by id. */
function useUpdateSlaPolicy(qc: QueryClient) {
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: Record<string, unknown> }) =>
      directus.request(updateItem('sla_policies', id, values as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sla-policies'] }),
  });
}

export function SlaPoliciesPage() {
  const { t } = useTranslation();
  const policies = useSlaPolicies();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      directus.request(createItem('sla_policies', input as never)),
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
  const [hours, setHours] = useState<HoursState>(DEFAULT_HOURS);
  // Only fetched once the operator is actually writing a policy — the list view
  // needs neither, and a page that fires three requests to render one table is
  // how a console gets slow one hook at a time.
  const lists = useOptionLists(open);
  const brands = useBrandNames(open);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });
  const selected = watch();

  const openCreate = () => {
    setEditingId(null);
    reset(DEFAULT_VALUES);
    setHours(hoursFromPolicy(null));
    setOpen(true);
  };
  const openEdit = (p: SlaPolicy) => {
    setEditingId(p.id);
    reset({
      name: p.name,
      description: p.description ?? '',
      governs: policyGoverns(p),
      first_response_minutes: p.first_response_minutes,
      resolution_minutes: p.resolution_minutes,
      warning_threshold_percent: p.warning_threshold_percent,
      applies_to_priority: p.applies_to_priority ?? [],
      applies_to_type: p.applies_to_type ?? [],
      applies_to_source: p.applies_to_source ?? [],
      applies_to_brand: p.applies_to_brand ?? [],
      active: p.active,
    });
    setHours(hoursFromPolicy(p.business_hours));
    setOpen(true);
  };
  const closeDrawer = () => {
    setOpen(false);
    setEditingId(null);
  };

  /* The policy the dialog is asking about. Holds the NAME as well as the id,
     so the heading can say which one without re-finding it in the list. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const remove = useDeleteSlaPolicy();
  const governed = useGovernedTicketCount(pendingDelete?.id ?? null);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    try {
      await remove.mutateAsync(id);
      toast.success(t('sla.deleted', { defaultValue: 'Policy "{{name}}" deleted.', name }));
      setPendingDelete(null);
    } catch {
      toast.error(t('sla.deleteError', { defaultValue: 'Could not delete the policy.' }));
    }
  };

  const problem = hoursProblem(hours);

  const onSubmit = handleSubmit(async (values) => {
    if (problem) {
      toast.error(
        problem === 'noDays'
          ? t('sla.hoursNoDays', { defaultValue: 'Open at least one day, or switch to 24/7.' })
          : t('sla.hoursBadWindow', {
              defaultValue: 'Each open day needs a closing time after its opening time.',
            }),
      );
      return;
    }
    const payload = { ...values, business_hours: hoursToPolicy(hours) };
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, values: payload });
        toast.success(t('sla.updated', { defaultValue: 'Policy updated.' }));
      } else {
        await create.mutateAsync(payload);
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
  // Policies that are switched on but cover nothing: live, listed, and silently
  // governing zero tickets. Counted here because that is exactly the state
  // nobody noticed for the whole life of the feature.
  const inertCount = list.filter((p) => p.active && scopeSpecificity(p) === 0).length;
  /*
   * Averaged over the policies that MEASURE it, not all of them.
   * `first_response_minutes` is a required column, so every ticket policy
   * carries a value it never reads — folding those into the average produced a
   * headline figure that moved when somebody edited a number nothing used.
   */
  const chatPolicies = list.filter((p) => policyGoverns(p) === 'chat');
  const avgFirst = chatPolicies.length
    ? Math.round(
        chatPolicies.reduce((a, p) => a + (p.first_response_minutes ?? 0), 0) / chatPolicies.length,
      )
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

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-5xl space-y-5">
          {/* Clean editorial header — no gradient banner. */}
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-foreground/10 pb-5">
            <div>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('sla.heroSubtitle', {
                  defaultValue:
                    'A policy says which tickets it covers, how fast they must be answered and solved, and when the clock runs. The most specific policy covering a ticket is the one it is held to.',
                })}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-3.5 py-1.5 text-sm font-semibold tabular-nums text-muted-foreground ring-1 ring-foreground/10">
              {t('sla.policyCount', { count: total, defaultValue: '{{count}} policies' })}
            </span>
          </div>

          {inertCount > 0 && (
            <p className="rounded-xl bg-warning-tint px-4 py-3 text-xs leading-relaxed text-foreground ring-1 ring-warning/25">
              {t('sla.inertWarning', {
                count: inertCount,
                defaultValue:
                  '{{count}} active policy covers no tickets — it names no priority, type, channel or brand, so nothing is ever held to it. Open it and choose what it covers.',
              })}
            </p>
          )}

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
            <>
              {/* Headline KPIs */}
              <div className="grid grid-cols-3 gap-3">
                <KpiTile
                  label={t('sla.kpiPolicies', { defaultValue: 'Policies' })}
                  value={total}
                  tone="blue"
                />
                <KpiTile
                  label={t('sla.kpiActive', { defaultValue: 'Active' })}
                  value={activeCount}
                  tone="green"
                />
                <KpiTile
                  label={t('sla.kpiAvgFirst', { defaultValue: 'Avg first reply' })}
                  value={`${avgFirst}m`}
                  tone="violet"
                />
              </div>

              {/* Policy CARDS, not a flat list: each policy is an object an
                  admin reasons about as a whole — what it covers, its three
                  deadlines, when its clock runs and whether it is live — and a
                  boxed card keeps those together instead of smearing them
                  along a row. */}
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {policies.data.map((p, i) => (
                  <article
                    key={p.id}
                    style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}
                    className="flex flex-col rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06] transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-safe:animate-rise-in"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
                        {p.name}
                      </h3>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {/* Which clock this is. Two policies can carry identical
                            coverage and mean entirely different promises, so the
                            object is not an optional detail on this card. */}
                        <Pill tone={policyGoverns(p) === 'chat' ? 'cyan' : 'purple'} size="sm">
                          {policyGoverns(p) === 'chat'
                            ? t('sla.governsChat', { defaultValue: 'Chat' })
                            : t('sla.governsTicket', { defaultValue: 'Ticket' })}
                        </Pill>
                        <Pill tone={p.active ? 'success' : 'muted'} size="sm" dot>
                          {p.active
                            ? t('sla.active')
                            : t('sla.inactive', { defaultValue: 'Inactive' })}
                        </Pill>
                      </div>
                    </div>

                    {p.description && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {p.description}
                      </p>
                    )}

                    <CoverageChips policy={p} t={t} />

                    {/*
                      ONLY THE TARGET THAT IS ACTUALLY MEASURED.
                      A chat policy's promise is its first reply; a ticket
                      policy's is its resolution. Showing both — as this card
                      used to — is how a ticket came to display a first-response
                      target that nothing in the product could ever satisfy, and
                      an operator had no way to tell the live number from the
                      decorative one. The warning threshold is a ticket concern
                      too: a five-minute chat target warned at 80% would page
                      twice, a minute apart.
                    */}
                    <div
                      className={cn(
                        'mt-4 grid gap-2',
                        policyGoverns(p) === 'chat' ? 'grid-cols-1' : 'grid-cols-2',
                      )}
                    >
                      {(policyGoverns(p) === 'chat'
                        ? ([
                            [
                              `${p.first_response_minutes}m`,
                              t('sla.rowFirstReply', { defaultValue: 'first reply' }),
                            ],
                          ] as const)
                        : ([
                            [
                              `${p.resolution_minutes}m`,
                              t('sla.rowResolution', { defaultValue: 'time to solve' }),
                            ],
                            [
                              `${p.warning_threshold_percent}%`,
                              t('sla.rowWarnAt', { defaultValue: 'warn at' }),
                            ],
                          ] as const)
                      ).map(([value, label]) => (
                        <div
                          key={label}
                          className="rounded-xl bg-secondary/40 px-3 py-2.5 text-center ring-1 ring-inset ring-foreground/[0.05]"
                        >
                          <div className="text-lg font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                            {value}
                          </div>
                          <div className="mt-1 text-2xs font-semibold uppercase leading-tight tracking-[0.06em] text-muted-foreground">
                            {label}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* When the clock runs. Said out loud on every card,
                        because "4 hours" means two different promises
                        depending on the answer. */}
                    <p className="mt-3 flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <ClockIcon />
                      {businessHoursSummary(p.business_hours) ??
                        t('sla.hoursAlways', { defaultValue: 'Round the clock' })}
                      {p.business_hours?.timezone ? ` · ${p.business_hours.timezone}` : ''}
                    </p>

                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-foreground/[0.07] pt-3">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={p.active}
                          onChange={(e) =>
                            void toggleActive.mutateAsync({ id: p.id, active: e.target.checked })
                          }
                          className="h-3.5 w-3.5 rounded-md border-border-strong bg-input accent-primary"
                          aria-label={t('sla.active')}
                        />
                        <span>{t('sla.active')}</span>
                      </label>
                      <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(p)}>
                        {t('actions.edit', { ns: 'common', defaultValue: 'Edit' })}
                      </Button>
                      {/* One button. The confirmation is a DIALOG rather than
                          this button turning red and asking again: a control
                          that changes meaning under the cursor is one you can
                          double-click straight through, and a policy is the
                          promise a whole class of tickets is held to. */}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingDelete({ id: p.id, name: p.name })}
                      >
                        {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/*
        WHAT IT COSTS, before the click that cannot be taken back.
        The FK is ON DELETE SET NULL, so the tickets survive — but each one
        silently loses the deadline it was being held to, with nothing on the
        ticket to say why. That number is fetched when the dialog opens and
        stated here, along with the gentler option: deactivating stops a policy
        governing anything NEW while leaving the tickets already under it alone.
      */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={t('sla.deleteTitle', {
          defaultValue: 'Delete "{{name}}"?',
          name: pendingDelete?.name ?? '',
        })}
        description={
          governed.isLoading
            ? t('sla.deleteChecking', { defaultValue: 'Checking what this policy governs…' })
            : (governed.data ?? 0) > 0
              ? t('sla.deleteWithTickets', {
                  count: governed.data ?? 0,
                  defaultValue:
                    '{{count}} open tickets are being held to this policy. Deleting it leaves them with no deadline at all — deactivate it instead to stop it governing anything new.',
                })
              : t('sla.deleteNoTickets', {
                  defaultValue:
                    'No tickets are currently held to this policy. Deleting it cannot be undone.',
                })
        }
        confirmLabel={t('sla.deleteConfirm', { defaultValue: 'Delete policy' })}
        cancelLabel={t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
        destructive
        loading={remove.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editingId ? t('sla.edit', { defaultValue: 'Edit policy' }) : t('sla.create')}
        description={t('sla.createHint', {
          defaultValue:
            'Choose what the policy covers, how fast, and when the clock runs. The worker schedules warnings and breach events from it automatically.',
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
            {/*
              THE FIRST QUESTION, not a detail buried under the deadlines.
              It decides which of the two targets below is real, which sweep
              reads the policy, and what the coverage rows are matched against.
            */}
            <FormField
              label={t('sla.governs', { defaultValue: 'What it measures' })}
              hint={t('sla.governsHint', {
                defaultValue:
                  'A chat policy promises how fast an agent first replies to a customer. A ticket policy promises how fast a complaint is solved.',
              })}
            >
              <Select {...register('governs')}>
                <option value="ticket">
                  {t('sla.governsTicketOption', { defaultValue: 'Ticket — time to solve' })}
                </option>
                <option value="chat">
                  {t('sla.governsChatOption', { defaultValue: 'Chat — first response' })}
                </option>
              </Select>
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
            {/*
              Only the target this policy actually measures is editable. Both
              columns still exist and both are still written — they are
              required — but an operator who can only see the live one cannot
              set a number that quietly does nothing, which is what the
              three-across row invited.
            */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {selected.governs === 'chat' ? (
                <FormField
                  label={`${t('sla.firstResponse')} (min)`}
                  hint={t('sla.firstResponseHint', {
                    defaultValue:
                      'Measured from the customer’s first message to the agent’s first reply.',
                  })}
                >
                  <Input type="number" {...register('first_response_minutes')} />
                </FormField>
              ) : (
                <>
                  <FormField
                    label={`${t('sla.resolution')} (min)`}
                    hint={t('sla.resolutionHint', {
                      defaultValue: 'Measured from when the ticket is raised to when it is solved.',
                    })}
                  >
                    <Input type="number" {...register('resolution_minutes')} />
                  </FormField>
                  <FormField label={`${t('sla.threshold')} (%)`}>
                    <Input type="number" {...register('warning_threshold_percent')} />
                  </FormField>
                </>
              )}
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('sla.sectionCoverage', { defaultValue: 'Which tickets it covers' })}
            description={t('sla.sectionCoverageHint', {
              defaultValue:
                'Leave a row untouched to ignore it. A ticket must match every row you do use — so priority High plus type Roach found covers only high-priority roach reports, and the most specific matching policy is the one that applies.',
            })}
          >
            <ChipGroup
              legend={t('sla.coveragePriority', { defaultValue: 'Priority' })}
              name="applies_to_priority"
              options={PRIORITIES}
              labelOf={(p) => t(`priority.${p}`, { ns: 'common' })}
              register={register}
            />
            <ChipGroup
              legend={t('sla.coverageType', { defaultValue: 'Ticket type' })}
              name="applies_to_type"
              options={optionsWith(lists.data, 'complaint_type', selected.applies_to_type ?? [])}
              register={register}
            />
            <ChipGroup
              legend={t('sla.coverageSource', { defaultValue: 'Arrived on' })}
              name="applies_to_source"
              options={optionsWith(
                lists.data,
                'complaint_source',
                selected.applies_to_source ?? [],
              )}
              register={register}
            />
            <ChipGroup
              legend={t('sla.coverageBrand', { defaultValue: 'Brand' })}
              name="applies_to_brand"
              options={brands.data ?? selected.applies_to_brand ?? []}
              emptyHint={t('sla.coverageBrandEmpty', {
                defaultValue: 'No brands in the restaurant list yet.',
              })}
              register={register}
            />
            {errors.applies_to_priority && (
              <span className="mt-1 block text-xs text-destructive">
                {t('sla.atLeastOneCoverage', {
                  defaultValue:
                    'Choose at least one value above, or this policy will never cover a ticket.',
                })}
              </span>
            )}
          </DrawerSection>

          <DrawerSection
            title={t('sla.sectionHours', { defaultValue: 'When the clock runs' })}
            description={t('sla.sectionHoursHint', {
              defaultValue:
                'Round the clock counts every minute, including overnight. Working hours count only the minutes inside the windows below, so a 4-hour target set at 16:00 is due the next morning rather than breached at 20:00.',
            })}
          >
            <HoursEditor value={hours} onChange={setHours} problem={problem} t={t} />
          </DrawerSection>
        </form>
      </Drawer>
    </div>
  );
}

/* ── Coverage chips on the card ────────────────────────────────────────── */

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * What this policy covers, one labelled row per dimension it names.
 *
 * A policy that names none says so in words. Rendering nothing would leave it
 * looking exactly like a working policy, which is how five inert ones stayed
 * invisible.
 */
function CoverageChips({ policy, t }: { policy: SlaPolicy; t: Translate }) {
  const rows: Array<[string, string[]]> = [
    [
      t('sla.coveragePriority', { defaultValue: 'Priority' }),
      (policy.applies_to_priority ?? []).map((p) => t(`priority.${p}`, { ns: 'common' })),
    ],
    [t('sla.coverageType', { defaultValue: 'Ticket type' }), policy.applies_to_type ?? []],
    [t('sla.coverageSource', { defaultValue: 'Arrived on' }), policy.applies_to_source ?? []],
    [t('sla.coverageBrand', { defaultValue: 'Brand' }), policy.applies_to_brand ?? []],
  ];
  const used = rows.filter(([, values]) => values.length > 0);
  if (used.length === 0) {
    return (
      <p className="mt-3 rounded-lg bg-warning-tint px-2.5 py-1.5 text-2xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
        {t('sla.coversNothing', {
          defaultValue: 'Covers no tickets — nothing is held to this policy.',
        })}
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      {used.map(([label, values]) => (
        <div key={label} className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {label}
          </span>
          {values.map((v) => (
            <Pill key={v} tone="primary" size="sm">
              {v}
            </Pill>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Form controls ─────────────────────────────────────────────────────── */

interface ChipGroupProps {
  legend: string;
  name: 'applies_to_priority' | 'applies_to_type' | 'applies_to_source' | 'applies_to_brand';
  options: readonly string[];
  labelOf?: (v: string) => string;
  emptyHint?: string;
  register: UseFormRegister<FormValues>;
}

/**
 * One coverage dimension as a row of checkbox chips.
 *
 * Checkboxes rather than a multi-select: the whole vocabulary is small enough
 * to read at a glance, and the question an operator is answering — "does this
 * cover late orders?" — is answered by looking, not by opening a menu.
 */
function ChipGroup({ legend, name, options, labelOf, emptyHint, register }: ChipGroupProps) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {legend}
      </legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <label
              key={o}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-strong bg-input px-2.5 py-1 text-xs text-foreground transition-colors duration-fast ease-out hover:bg-secondary"
            >
              <input
                type="checkbox"
                value={o}
                className="h-3.5 w-3.5 rounded-md border-border-strong bg-input accent-primary"
                {...register(name)}
              />
              {labelOf ? labelOf(o) : o}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function HoursEditor({
  value,
  onChange,
  problem,
  t,
}: {
  value: HoursState;
  onChange: (h: HoursState) => void;
  problem: 'noDays' | 'badWindow' | null;
  t: Translate;
}) {
  const setDay = (i: number, patch: Partial<DayState>) =>
    onChange({ ...value, days: value.days.map((d, k) => (k === i ? { ...d, ...patch } : d)) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['always', t('sla.hoursAlways', { defaultValue: 'Round the clock' })],
            ['business', t('sla.hoursBusiness', { defaultValue: 'Working hours' })],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChange({ ...value, mode })}
            aria-pressed={value.mode === mode}
            className={cn(
              'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-fast ease-out',
              value.mode === mode
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {value.mode === 'business' && (
        <div className="space-y-2 rounded-xl bg-secondary/40 p-3 ring-1 ring-inset ring-foreground/[0.05]">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-24 shrink-0">{t('sla.timezone', { defaultValue: 'Timezone' })}</span>
            <select
              value={value.timezone}
              onChange={(e) => onChange({ ...value, timezone: e.target.value })}
              className="h-8 rounded-md border border-border-strong bg-input px-2 text-xs text-foreground"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>

          {value.days.map((d, i) => (
            <div key={SLA_WEEKDAYS[i]} className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex w-32 shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={d.on}
                  onChange={(e) => setDay(i, { on: e.target.checked })}
                  className="h-3.5 w-3.5 rounded-md border-border-strong bg-input accent-primary"
                />
                <span className={d.on ? 'text-foreground' : 'text-muted-foreground'}>
                  {t(`weekday.${i}`, { ns: 'common', defaultValue: SLA_WEEKDAYS[i]! })}
                </span>
              </label>
              <input
                type="time"
                value={d.open}
                disabled={!d.on}
                onChange={(e) => setDay(i, { open: e.target.value })}
                aria-label={`${SLA_WEEKDAYS[i]} ${t('sla.opensAt', { defaultValue: 'opens at' })}`}
                className="h-8 rounded-md border border-border-strong bg-input px-2 text-xs text-foreground disabled:opacity-40"
              />
              <span className="text-muted-foreground">–</span>
              <input
                type="time"
                value={d.close}
                disabled={!d.on}
                onChange={(e) => setDay(i, { close: e.target.value })}
                aria-label={`${SLA_WEEKDAYS[i]} ${t('sla.closesAt', { defaultValue: 'closes at' })}`}
                className="h-8 rounded-md border border-border-strong bg-input px-2 text-xs text-foreground disabled:opacity-40"
              />
            </div>
          ))}

          {problem && (
            <p className="text-xs text-destructive">
              {problem === 'noDays'
                ? t('sla.hoursNoDays', {
                    defaultValue: 'Open at least one day, or switch to 24/7.',
                  })
                : t('sla.hoursBadWindow', {
                    defaultValue: 'Each open day needs a closing time after its opening time.',
                  })}
            </p>
          )}
        </div>
      )}
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

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="h-3 w-3 shrink-0"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}

/* Board KPI tile — hue numeral + dot micro-label, the stat-tile anatomy of the
   reference dashboards. */
type KpiTone = 'blue' | 'violet' | 'green' | 'amber';
const NUM_TONE: Record<KpiTone, string> = {
  // Literals, not tokens, for the same reason as the dashboard's KPI_NUMERALS:
  // --sky and --success are tuned to fill a chip and miss 4.5:1 as a numeral.
  // Same hue, darkened until it passes — keep the hue in step with the token.
  blue: 'text-[oklch(0.48_0.16_264)]',
  violet: 'text-[oklch(0.48_0.19_285)]',
  green: 'text-[oklch(0.45_0.13_155)]',
  // Warning is a light token — its ink flips per theme — so the amber numeral
  // stays in foreground ink and the dot alone carries the hue.
  amber: 'text-foreground',
};

/* The card surface carries the hue too, matching the KPI cards on the dashboard
   and the report pages. Without this the SLA tiles were the only plain-white
   stat tiles in the admin portal. */
const SURFACE_TONE: Record<KpiTone, string> = {
  blue: 'bg-gradient-to-br from-sky-tint/70 to-card ring-sky/15',
  violet: 'bg-gradient-to-br from-violet-tint/70 to-card ring-violet/15',
  green: 'bg-gradient-to-br from-success-tint/70 to-card ring-success/15',
  amber: 'bg-gradient-to-br from-warning-tint/70 to-card ring-warning/15',
};
const DOT_TONE: Record<KpiTone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
};

function KpiTile({ label, value, tone }: { label: string; value: string | number; tone: KpiTone }) {
  return (
    <div className={cn('rounded-2xl px-4 py-3.5 shadow-soft ring-1', SURFACE_TONE[tone])}>
      <div
        className={cn(
          'text-3xl font-extrabold tabular-nums leading-none tracking-[-0.03em]',
          NUM_TONE[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
}
