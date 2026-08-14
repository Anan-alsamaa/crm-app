import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  cn,
  ConfirmDialog,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  SelectMenu,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useReports,
  useCreateReport,
  useUpdateReport,
  useDeleteReport,
  type ReportRow,
  type ReportInput,
  type ReportType,
} from './api.js';
import { useUsers } from '../users/api.js';
import { useTeams } from '../teams/api.js';
import { jobProducer } from '../../lib/job-producer.js';

/**
 * Reports admin — list of saved reports + create/edit drawer.
 *
 * The worker's `reports` queue runs the aggregation on demand (or on
 * schedule). This UI doesn't render the data itself — it manages the
 * saved report definitions and surfaces the last-run timestamp.
 */

const TYPES: ReportType[] = [
  'conversation_volume',
  'response_time',
  'sla_compliance',
  'ticket_resolution',
  'agent_productivity',
  'csat',
  'vendor_activity',
];

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

interface Draft {
  name: string;
  description: string;
  type: ReportType;
  from: string;
  to: string;
  vendor: string;
  agent: string;
  team: string;
  emailRecipients: string;
  /** A preset key, or 'custom' when the cron was typed by hand. */
  frequency: FrequencyKey;
  cron: string;
}

/**
 * How often a report runs, as presets over cron.
 *
 * Recipients used to be the only schedule field on this form, so `schedule.cron`
 * was never written and no saved report ever fired — a report with an email
 * address on it and no way to trigger looks configured and is not. The presets
 * cover what operations actually ask for; the raw expression stays available
 * for anything else, because a picker that cannot express "every other Tuesday"
 * must not be the only way in.
 *
 * 07:00 rather than midnight: a report generated at 00:00 on the 1st covers a
 * month that ended sixty seconds ago and lands in an inbox nobody opens until
 * morning anyway.
 */
const FREQUENCIES = {
  manual: { cron: '', labelKey: 'reports.freqManual', label: 'Manual only' },
  daily: { cron: '0 7 * * *', labelKey: 'reports.freqDaily', label: 'Every day at 07:00' },
  weekly: { cron: '0 7 * * 1', labelKey: 'reports.freqWeekly', label: 'Every Monday at 07:00' },
  monthly: {
    cron: '0 7 1 * *',
    labelKey: 'reports.freqMonthly',
    label: 'The 1st of every month at 07:00',
  },
  custom: { cron: '', labelKey: 'reports.freqCustom', label: 'Custom (cron)' },
} as const;
type FrequencyKey = keyof typeof FREQUENCIES;

/** The preset a stored cron came from, or 'custom' when it matches none. */
function frequencyOf(cron: string | undefined): FrequencyKey {
  const c = (cron ?? '').trim();
  if (!c) return 'manual';
  const hit = (Object.keys(FREQUENCIES) as FrequencyKey[]).find(
    (k) => k !== 'custom' && k !== 'manual' && FREQUENCIES[k].cron === c,
  );
  return hit ?? 'custom';
}

const blank = (): Draft => ({
  name: '',
  description: '',
  type: 'conversation_volume',
  from: '',
  to: '',
  vendor: '',
  agent: '',
  team: '',
  emailRecipients: '',
  frequency: 'manual',
  cron: '',
});

export function ReportsPage() {
  const { t } = useTranslation();
  const reports = useReports();
  const create = useCreateReport();
  const update = useUpdateReport();
  const remove = useDeleteReport();
  const users = useUsers();
  const teams = useTeams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // "Run now" — enqueue a ReportJob on the workers `reports` queue via the
  // host-run job producer (tools/job-producer). The worker runs the
  // aggregation, renders CSV, emails recipients, and bumps last_run_at.
  const runNow = useMutation({
    mutationFn: (reportId: string) => jobProducer.enqueueReport(reportId),
    onSuccess: (info) =>
      toast.success(
        t('reports.runQueued', {
          jobId: info.jobId,
          defaultValue: 'Report queued (job {{jobId}}). The worker will run it shortly.',
        }),
      ),
    onError: (err) =>
      toast.error(
        t('reports.runError', {
          message: (err as Error).message,
          defaultValue: 'Could not run report: {{message}}',
        }),
      ),
  });

  const onDelete = async (): Promise<void> => {
    if (!deletingId) return;
    try {
      await remove.mutateAsync(deletingId);
      setDeletingId(null);
    } catch {
      toast.error(t('reports.deleteError', { defaultValue: 'Could not delete report.' }));
    }
  };

  useEffect(() => {
    if (!drawerOpen) return;
    if (editingId) {
      const existing = reports.data?.find((r) => r.id === editingId);
      if (existing) {
        setDraft({
          name: existing.name,
          description: existing.description ?? '',
          type: existing.type,
          from: existing.filters?.from ?? '',
          to: existing.filters?.to ?? '',
          vendor: existing.filters?.vendor ?? '',
          agent: existing.filters?.agent ?? '',
          team: existing.filters?.team ?? '',
          emailRecipients: (existing.schedule?.email ?? []).join(', '),
          frequency: frequencyOf(existing.schedule?.cron),
          cron: existing.schedule?.cron ?? '',
        });
      }
    } else {
      setDraft(blank());
    }
  }, [drawerOpen, editingId, reports.data]);

  const onSubmit = async (): Promise<void> => {
    if (!draft.name.trim()) {
      toast.error(t('reports.nameRequired', { defaultValue: 'Name is required.' }));
      return;
    }
    const payload: ReportInput = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      type: draft.type,
      filters: {
        ...(draft.from ? { from: draft.from } : {}),
        ...(draft.to ? { to: draft.to } : {}),
        ...(draft.vendor ? { vendor: draft.vendor.trim() } : {}),
        ...(draft.agent ? { agent: draft.agent } : {}),
        ...(draft.team ? { team: draft.team } : {}),
      },
      schedule: {
        email: draft.emailRecipients
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        // Written at last: without a cron the workers' scheduler has nothing to
        // register, and the report only ever runs when somebody clicks Run now.
        cron: draft.frequency === 'custom' ? draft.cron.trim() : FREQUENCIES[draft.frequency].cron,
      },
    };
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, patch: payload });
        toast.success(t('reports.updated', { defaultValue: 'Report updated.' }));
      } else {
        await create.mutateAsync(payload);
        toast.success(t('reports.created', { defaultValue: 'Report created.' }));
      }
      setDrawerOpen(false);
      setEditingId(null);
    } catch {
      toast.error(t('reports.saveError', { defaultValue: 'Could not save report.' }));
    }
  };

  const total = reports.data?.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        {/* Title only, as the sibling report pages do — the editorial header
            below carries the subtitle and the saved count, so repeating them up
            here made the two headers read as a collision. */}
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('reports.title', { defaultValue: 'Scheduled reports' })}
        </h1>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditingId(null);
            setDrawerOpen(true);
          }}
          iconStart={<PlusIcon />}
        >
          {t('reports.create', { defaultValue: 'New report' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-5xl space-y-5">
          {/* Clean editorial header — no gradient banner. */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-foreground/10 pb-5">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                {t('reports.title', { defaultValue: 'Scheduled reports' })}
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('reports.heroSubtitle', {
                  defaultValue:
                    'Saved report definitions that run automatically on a schedule and email a CSV to their recipients. Set once, delivered on time.',
                })}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-3.5 py-1.5 text-sm font-semibold tabular-nums text-muted-foreground ring-1 ring-foreground/10">
              {t('reports.savedCount', { count: total, defaultValue: '{{count}} saved' })}
            </span>
          </div>

          {reports.isError ? (
            <ErrorState
              title={t('reports.loadError', { defaultValue: 'Could not load reports' })}
              message={t('reports.loadErrorHint', {
                defaultValue: 'Check your connection and try again.',
              })}
              retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
              onRetry={() => void reports.refetch()}
            />
          ) : reports.isLoading ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full rounded-2xl" />
              ))}
            </div>
          ) : !reports.data || reports.data.length === 0 ? (
            <EmptyState
              title={t('reports.empty', { defaultValue: 'No saved reports yet.' })}
              description={t('reports.emptyHint', {
                defaultValue:
                  'Create a saved report to schedule periodic emails or run on demand from this list.',
              })}
              action={
                <Button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setDrawerOpen(true);
                  }}
                  iconStart={<PlusIcon />}
                >
                  {t('reports.create', { defaultValue: 'New report' })}
                </Button>
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {reports.data.map((r) => (
                <li key={r.id}>
                  <ReportCard
                    r={r}
                    onEdit={() => {
                      setEditingId(r.id);
                      setDrawerOpen(true);
                    }}
                    onDelete={() => setDeletingId(r.id)}
                    onRun={() => runNow.mutate(r.id)}
                    running={runNow.isPending && runNow.variables === r.id}
                  />
                </li>
              ))}
              {/* Ghost tile — the next report's parking space. With one or two
                  saved reports the grid was a card in a corner of dead canvas;
                  the dashed slot fills the rhythm and is the affordance the page
                  is for anyway. */}
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setDrawerOpen(true);
                  }}
                  className="flex h-full min-h-[10rem] w-full flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-foreground/10 text-muted-foreground transition-colors duration-base ease-out hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
                >
                  <span
                    aria-hidden
                    className="grid h-9 w-9 place-items-center rounded-lg bg-secondary/80"
                  >
                    <PlusIcon />
                  </span>
                  <span className="text-xs font-semibold">
                    {t('reports.create', { defaultValue: 'New report' })}
                  </span>
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingId(null);
        }}
        title={
          editingId
            ? t('reports.edit', { defaultValue: 'Edit report' })
            : t('reports.create', { defaultValue: 'New report' })
        }
        description={t('reports.drawerHint', {
          defaultValue:
            'Filters scope the data; the email schedule runs the report and sends a CSV.',
        })}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDrawerOpen(false);
                setEditingId(null);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="button" onClick={onSubmit} loading={create.isPending || update.isPending}>
              {t('actions.save', { ns: 'common' })}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <DrawerSection
            title={t('reports.sectionMeta', { defaultValue: 'Report' })}
            description={t('reports.sectionMetaHint', {
              defaultValue: 'Pick a report type — each computes a different aggregation.',
            })}
          >
            <FormField label={t('reports.name', { defaultValue: 'Name' })}>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </FormField>
            <FormField label={t('reports.description', { defaultValue: 'Description' })}>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </FormField>
            <FormField label={t('reports.type', { defaultValue: 'Type' })}>
              <select
                className="block w-full rounded-xl bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 ring-1 ring-inset ring-foreground/[0.06] transition-[box-shadow,background-color,ring-color] duration-fast ease-out hover:bg-secondary/60 focus:outline-none focus:bg-card focus:ring-2 focus:ring-primary/40 h-10 ps-3.5 pe-9 text-sm text-start appearance-none cursor-pointer"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as ReportType })}
              >
                {TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </select>
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('reports.sectionFilters', { defaultValue: 'Filters' })}
            description={t('reports.sectionFiltersHint', {
              defaultValue: 'Date range (ISO) and optional vendor scope.',
            })}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('reports.from', { defaultValue: 'From' })}>
                <Input
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
              </FormField>
              <FormField label={t('reports.to', { defaultValue: 'To' })}>
                <Input
                  type="date"
                  value={draft.to}
                  onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                />
              </FormField>
            </div>
            <FormField label={t('reports.vendor', { defaultValue: 'Vendor (optional)' })}>
              <Input
                value={draft.vendor}
                onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
                placeholder={t('reports.vendorPlaceholder', { defaultValue: 'vendor-uuid' })}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('reports.agent', { defaultValue: 'Agent (optional)' })}>
                <SelectMenu
                  fullWidth
                  value={draft.agent}
                  aria-label={t('reports.agent', { defaultValue: 'Agent (optional)' })}
                  onChange={(v) => setDraft({ ...draft, agent: v })}
                  options={[
                    { value: '', label: t('reports.anyAgent', { defaultValue: 'Any agent' }) },
                    ...(users.data ?? []).map((u) => ({
                      value: u.id,
                      label: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
                    })),
                  ]}
                />
              </FormField>
              <FormField label={t('reports.team', { defaultValue: 'Team (optional)' })}>
                <SelectMenu
                  fullWidth
                  value={draft.team}
                  aria-label={t('reports.team', { defaultValue: 'Team (optional)' })}
                  onChange={(v) => setDraft({ ...draft, team: v })}
                  options={[
                    { value: '', label: t('reports.anyTeam', { defaultValue: 'Any team' }) },
                    ...(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })),
                  ]}
                />
              </FormField>
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('reports.sectionSchedule', { defaultValue: 'Email schedule' })}
            description={t('reports.sectionScheduleHint', {
              defaultValue:
                'Comma-separated email addresses to receive the CSV when the report runs.',
            })}
          >
            <FormField label={t('reports.recipients', { defaultValue: 'Recipients' })}>
              <Input
                value={draft.emailRecipients}
                onChange={(e) => setDraft({ ...draft, emailRecipients: e.target.value })}
                placeholder={t('reports.recipientsPlaceholder', {
                  defaultValue: 'ops@example.com, manager@example.com',
                })}
              />
            </FormField>
            <FormField
              label={t('reports.frequency', { defaultValue: 'How often' })}
              hint={
                draft.frequency === 'manual'
                  ? t('reports.freqManualHint', {
                      defaultValue: 'Nothing is sent automatically — only "Run now".',
                    })
                  : undefined
              }
            >
              <SelectMenu
                fullWidth
                value={draft.frequency}
                onChange={(v) => setDraft({ ...draft, frequency: v as FrequencyKey })}
                aria-label={t('reports.frequency', { defaultValue: 'How often' })}
                options={(Object.keys(FREQUENCIES) as FrequencyKey[]).map((k) => ({
                  value: k,
                  label: t(FREQUENCIES[k].labelKey, { defaultValue: FREQUENCIES[k].label }),
                }))}
              />
            </FormField>
            {draft.frequency === 'custom' && (
              <FormField
                label={t('reports.cron', { defaultValue: 'Cron expression' })}
                hint={t('reports.cronHint', {
                  defaultValue: 'Five fields: minute hour day-of-month month day-of-week.',
                })}
              >
                <Input
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder="0 7 1 * *"
                />
              </FormField>
            )}
            {/* Says what will happen, in words. A cron expression is not a
                sentence most people can read back, and "did I schedule this
                correctly" is the question this form has to answer. */}
            {draft.frequency !== 'manual' && (
              <p className="rounded-xl bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-foreground">
                {draft.emailRecipients.trim()
                  ? t('reports.scheduleSummary', {
                      defaultValue: 'Sent to {{who}} — {{when}}.',
                      who: draft.emailRecipients.trim(),
                      when: t(FREQUENCIES[draft.frequency].labelKey, {
                        defaultValue: FREQUENCIES[draft.frequency].label,
                      }).toLowerCase(),
                    })
                  : t('reports.scheduleNoRecipients', {
                      defaultValue:
                        'It will run on schedule, but with no recipients nobody receives it.',
                    })}
              </p>
            )}
          </DrawerSection>
        </div>
      </Drawer>

      <ConfirmDialog
        open={deletingId !== null}
        destructive
        title={t('reports.confirmDelete', { defaultValue: 'Delete this report?' })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
        loading={remove.isPending}
        onConfirm={() => void onDelete()}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}

function ReportCard({
  r,
  onEdit,
  onDelete,
  onRun,
  running,
}: {
  r: ReportRow;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
  running: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl bg-card px-5 py-4',
        'shadow-soft ring-1 ring-foreground/[0.06]',
        'transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
      )}
    >
      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{r.name}</h3>
        {/* The machine type as a quiet tag chip — same text, board dressing. */}
        <p>
          <span className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground ring-1 ring-inset ring-foreground/[0.06]">
            {r.type}
          </span>
        </p>
        {r.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1.5">
          {/* Run-state dot: jade once it has run, quiet until then. */}
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              r.last_run_at ? 'bg-success' : 'bg-muted-foreground/50',
            )}
          />
          {r.last_run_at
            ? `${t('reports.lastRun', { defaultValue: 'Last run' })}: ${new Date(r.last_run_at).toLocaleString()}`
            : t('reports.neverRun', { defaultValue: 'Never run' })}
        </span>
        {(r.schedule?.email?.length ?? 0) > 0 && (
          <span>
            ✉ {r.schedule!.email!.length}{' '}
            {t('reports.recipientsShort', { defaultValue: 'recipients' })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 pt-1">
        <Button type="button" size="sm" variant="secondary" loading={running} onClick={onRun}>
          {t('reports.runNow', { defaultValue: 'Run now' })}
        </Button>
        <ToolbarSpacer />
        {/* Quiet chip buttons rather than underlined text links — the same
            words, dressed as the actions they are. */}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors duration-fast ease-out hover:bg-primary/10"
        >
          {t('actions.edit', { ns: 'common', defaultValue: 'edit' })}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors duration-fast ease-out hover:bg-destructive/10"
        >
          {t('actions.delete', { ns: 'common', defaultValue: 'delete' })}
        </button>
      </div>
    </div>
  );
}
