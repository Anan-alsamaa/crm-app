import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  Drawer,
  DrawerSection,
  EmptyState,
  FormField,
  Input,
  Select,
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
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('reports.title', { defaultValue: 'Reports' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong>{' '}
            {t('reports.saved', { defaultValue: 'saved' })}
          </span>
        </span>
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

      <div className="flex-1 overflow-auto px-5 py-3">
        {reports.isLoading ? (
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
                  onDelete={async () => {
                    if (
                      !confirm(t('reports.confirmDelete', { defaultValue: 'Delete this report?' }))
                    )
                      return;
                    await remove.mutateAsync(r.id);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
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
                placeholder="vendor-uuid"
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('reports.agent', { defaultValue: 'Agent (optional)' })}>
                <Select
                  value={draft.agent}
                  onChange={(e) => setDraft({ ...draft, agent: e.target.value })}
                >
                  <option value="">{t('reports.anyAgent', { defaultValue: 'Any agent' })}</option>
                  {(users.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t('reports.team', { defaultValue: 'Team (optional)' })}>
                <Select
                  value={draft.team}
                  onChange={(e) => setDraft({ ...draft, team: e.target.value })}
                >
                  <option value="">{t('reports.anyTeam', { defaultValue: 'Any team' })}</option>
                  {(teams.data ?? []).map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </Select>
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
                placeholder="ops@example.com, manager@example.com"
              />
            </FormField>
          </DrawerSection>
        </div>
      </Drawer>
    </div>
  );
}

function ReportCard({
  r,
  onEdit,
  onDelete,
}: {
  r: ReportRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl bg-card/70 px-5 py-4',
        'shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04]',
      )}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{r.name}</h3>
        <p className="text-2xs font-mono text-muted-foreground">{r.type}</p>
        {r.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
        <span>
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
        <button
          type="button"
          onClick={onEdit}
          className="text-xs font-semibold text-[oklch(0.42_0.10_196)] underline-offset-2 hover:underline"
        >
          {t('actions.edit', { ns: 'common', defaultValue: 'edit' })}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-2xs font-medium text-destructive underline-offset-2 hover:underline"
        >
          {t('actions.delete', { ns: 'common', defaultValue: 'delete' })}
        </button>
      </div>
    </div>
  );
}
