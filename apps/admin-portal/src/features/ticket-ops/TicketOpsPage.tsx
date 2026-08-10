import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Pill,
  SelectMenu,
  Pagination,
  Skeleton,
  SortTh,
  Spinner,
  Table,
  TableSurface,
  Td,
  Th,
  Toolbar,
  ToolbarSpacer,
  Tr,
  useTableSort,
} from '@yiji/ui';
import { commerce } from '../../lib/commerce-client.js';
import { useTicketOps, type AgentLoad, type TicketOpsRow, type TicketOps } from './api.js';

const RANGE_DAYS = [7, 30, 90] as const;

const PRIORITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'destructive'> = {
  low: 'muted',
  medium: 'neutral',
  high: 'warning',
  urgent: 'destructive',
};
const STATUS_TONE: Record<string, 'primary' | 'success' | 'warning' | 'muted' | 'neutral'> = {
  new: 'primary',
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};

// Rank maps so priority/status sort by severity, not alphabetically.
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<string, number> = {
  new: 0,
  open: 1,
  pending: 2,
  resolved: 3,
  closed: 4,
};

const REGISTER_PAGE_SIZE = 10;
const REGISTER_SORT: Record<string, (r: TicketOpsRow) => string | number | null | undefined> = {
  ticket: (r) => r.subject.toLowerCase(),
  priority: (r) => PRIORITY_RANK[r.priority] ?? 99,
  status: (r) => STATUS_RANK[r.status] ?? 99,
  agent: (r) => r.agentName.toLowerCase(),
  created: (r) => r.created ?? '',
  firstResponse: (r) => r.responseMinutes,
  resolved: (r) => r.resolvedAt ?? '',
  age: (r) => r.ageHours,
};

/* ── formatters ─────────────────────────────────────────────────────────── */
function fmtDuration(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}
function fmtAge(hours: number | null): string {
  if (hours == null) return '—';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
function fmtDateOnly(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTimeOnly(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Two-line cell: a primary value with a muted secondary line beneath it. */
function Stacked({
  primary,
  secondary,
}: {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-foreground">{primary}</div>
      {secondary != null && secondary !== '' && (
        <div className="truncate text-2xs text-muted-foreground">{secondary}</div>
      )}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  );
}
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── KPI card — vibrant tinted card, colored number (reference style) ────── */
type Tone = 'blue' | 'violet' | 'green' | 'amber' | 'crimson' | 'slate';
/* Colour as ACCENT, not surface. Solid saturated fills across a six-tile row
 * read as a toy dashboard, and full-saturation colour on an inactive display is
 * a product-register ban. White card + ink numeral carries the hierarchy
 * (~19.5:1); the tone survives as a state-indicator dot. `slate` stays a
 * neutral dot for the neutral tile. */
const DOT_TONE: Record<Tone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
  crimson: 'bg-destructive',
  slate: 'bg-foreground/25',
};

function KpiTile({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card px-4 py-4 shadow-soft ring-1 ring-border transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
      )}
    >
      <div className="text-4xl font-bold tabular-nums leading-none tracking-[-0.03em] text-foreground">
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
        {label}
      </div>
    </div>
  );
}

function Breakdown({
  title,
  items,
  label,
  toneClass,
}: {
  title: string;
  items: Array<{ key: string; count: number }>;
  label: (key: string) => string;
  toneClass: (key: string) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const total = items.reduce((s, i) => s + i.count, 0) || 1;
  return (
    <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.05] shadow-soft">
      <h3 className="mb-4 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-3">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 truncate font-medium text-foreground">
              {label(i.key)}
            </span>
            <span className="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
              <span
                className={cn('block h-full rounded-full', toneClass(i.key))}
                style={{ width: `${(i.count / max) * 100}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-end tabular-nums">
              <span className="font-bold text-foreground">{i.count}</span>
              <span className="ms-1 text-2xs text-muted-foreground">
                {Math.round((i.count / total) * 100)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TicketOpsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const report = useTicketOps(days);
  const data = report.data;

  const STATUS_BAR: Record<string, string> = {
    new: 'bg-primary',
    open: 'bg-success',
    pending: 'bg-warning',
    resolved: 'bg-primary/60',
    closed: 'bg-muted-foreground/50',
  };
  const PRIORITY_BAR: Record<string, string> = {
    urgent: 'bg-destructive',
    high: 'bg-warning',
    medium: 'bg-primary',
    low: 'bg-muted-foreground/50',
  };

  const exportCsv = () => {
    if (!data) return;
    const rows: (string | number)[][] = [
      [
        'ticket_id',
        'subject',
        'status',
        'priority',
        'agent',
        'team',
        'contact',
        'created',
        'first_responded_at',
        'resolved_at',
        'closed_at',
        'response_min',
        'resolution_min',
        'overdue',
        'age_hours',
      ],
      ...data.rows.map((r) => [
        r.id,
        r.subject,
        r.status,
        r.priority,
        r.agentName,
        r.teamName,
        r.contactName,
        r.created ?? '',
        r.firstRespondedAt ?? '',
        r.resolvedAt ?? '',
        r.closedAt ?? '',
        r.responseMinutes == null ? '' : Math.round(r.responseMinutes),
        r.resolutionMinutes == null ? '' : Math.round(r.resolutionMinutes),
        r.overdue ? 'yes' : 'no',
        r.ageHours == null ? '' : Math.round(r.ageHours),
      ]),
    ];
    downloadCsv(`ticket-report-${days}d.csv`, rows);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('ticketOps.title', { defaultValue: 'Ticket report' })}
        </h1>
        <ToolbarSpacer />
        <div className="w-32">
          <SelectMenu
            fullWidth
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            aria-label={t('ticketOps.range', { defaultValue: 'Date range' })}
            options={RANGE_DAYS.map((d) => ({
              value: String(d),
              label: t('ticketOps.lastDays', {
                count: d,
                days: d,
                defaultValue: 'Last {{days}} days',
              }),
            }))}
          />
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={exportCsv} disabled={!data}>
          {t('ticketOps.exportCsv', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {report.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : !data || data.totals.total === 0 ? (
          <EmptyState
            title={t('ticketOps.empty', { defaultValue: 'No tickets in this window' })}
            description={t('ticketOps.emptyHint', {
              defaultValue: 'Widen the date range, or wait for new tickets to arrive.',
            })}
          />
        ) : (
          <div className="mx-auto max-w-5xl space-y-5">
            {/* Clean editorial header — no gradient banner. */}
            <div className="border-b border-foreground/10 pb-5">
              <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                {t('ticketOps.heroTitle', { defaultValue: 'Ticket report' })}
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('ticketOps.heroSubtitle', {
                  defaultValue:
                    'Every support ticket in this window: its lifecycle, whether it is overdue, who is carrying the load, and the customer order behind each one.',
                })}
              </p>
            </div>

            {/* Headline backlog KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <KpiTile
                label={t('ticketOps.kpiTotal', { defaultValue: 'Tickets' })}
                value={data.totals.total}
                tone="blue"
              />
              <KpiTile
                label={t('ticketOps.kpiOpen', { defaultValue: 'Open backlog' })}
                value={data.totals.open}
                tone="violet"
              />
              <KpiTile
                label={t('ticketOps.kpiOverdue', { defaultValue: 'Overdue' })}
                value={data.totals.overdue}
                tone="crimson"
              />
              <KpiTile
                label={t('ticketOps.kpiUnassigned', { defaultValue: 'Unassigned' })}
                value={data.totals.unassigned}
                tone="amber"
              />
              <KpiTile
                label={t('ticketOps.kpiResolved', { defaultValue: 'Resolved' })}
                value={data.totals.resolved}
                tone="green"
              />
              <KpiTile
                label={t('ticketOps.kpiClosed', { defaultValue: 'Closed' })}
                value={data.totals.closed}
                tone="slate"
              />
            </div>

            {/* Lifecycle timing */}
            <div className="grid grid-cols-3 gap-3 rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.05] shadow-soft">
              <Timing
                label={t('ticketOps.medianResponse', { defaultValue: 'Median 1st response' })}
                value={fmtDuration(data.timing.medianResponseMin)}
              />
              <Timing
                label={t('ticketOps.medianResolution', { defaultValue: 'Median resolution' })}
                value={fmtDuration(data.timing.medianResolutionMin)}
              />
              <Timing
                label={t('ticketOps.avgResolution', { defaultValue: 'Avg resolution' })}
                value={fmtDuration(data.timing.avgResolutionMin)}
              />
            </div>

            {/* Breakdowns */}
            <div className="grid gap-3 md:grid-cols-2">
              <Breakdown
                title={t('ticketOps.byStatus', { defaultValue: 'By status' })}
                items={data.byStatus}
                label={(k) => t(`status.${k}`, { ns: 'common', defaultValue: k })}
                toneClass={(k) => STATUS_BAR[k] ?? 'bg-primary'}
              />
              <Breakdown
                title={t('ticketOps.byPriority', { defaultValue: 'By priority' })}
                items={data.byPriority}
                label={(k) => t(`priority.${k}`, { ns: 'common', defaultValue: k })}
                toneClass={(k) => PRIORITY_BAR[k] ?? 'bg-primary'}
              />
            </div>

            {/* Agent workload */}
            <AgentTable agents={data.agents} />

            {/* Ticket register — each row expands to the linked customer order. */}
            <TicketRegister rows={data.rows} />
          </div>
        )}
      </div>
    </div>
  );
}

function Timing({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl font-black tabular-nums tracking-[-0.03em] text-foreground">
        {value}
      </div>
      <div className="mt-1 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

/** Agent workload — now ALSO rendered by the Agent KPI report. */
export function AgentTable({ agents }: { agents: AgentLoad[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h3 className="px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t('ticketOps.agentLoad', { defaultValue: 'Agent workload' })}
      </h3>
      <TableSurface>
        <Table>
          <thead>
            <tr>
              <Th>{t('ticketOps.colAgent', { defaultValue: 'Agent' })}</Th>
              <Th className="text-end">{t('ticketOps.colTotal', { defaultValue: 'Total' })}</Th>
              <Th className="text-end">{t('ticketOps.colOpen', { defaultValue: 'Open' })}</Th>
              <Th className="text-end">{t('ticketOps.colOverdue', { defaultValue: 'Overdue' })}</Th>
              <Th className="text-end">
                {t('ticketOps.colResolved', { defaultValue: 'Resolved' })}
              </Th>
              <Th className="text-end">
                {t('ticketOps.colAvgResolution', { defaultValue: 'Avg resolution' })}
              </Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <Tr key={a.agentId ?? '__unassigned__'}>
                <Td className="font-medium">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={a.agentName} size="sm" />
                    <span className="truncate">{a.agentName}</span>
                  </span>
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">{a.total}</Td>
                <Td className="text-end tabular-nums">{a.open}</Td>
                <Td className="text-end tabular-nums">
                  <span
                    className={
                      a.overdue > 0 ? 'font-bold text-destructive' : 'text-muted-foreground'
                    }
                  >
                    {a.overdue}
                  </span>
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">{a.resolved}</Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {fmtDuration(a.avgResolutionMin)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
    </div>
  );
}

/** Colored dot per status for the filter-tab bar. */
const STATUS_DOT: Record<string, string> = {
  new: 'bg-sky',
  open: 'bg-emerald-500',
  pending: 'bg-orange-400',
  resolved: 'bg-violet',
  closed: 'bg-slate-400',
};

/** Ticket register — now ALSO rendered by the Tickets report. */
export function TicketRegister({ rows }: { rows: TicketOpsRow[] }) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Live counts per status, in lifecycle order — the reference's tab bar.
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const tabs = [
    { key: 'all', label: t('ticketOps.filterAll', { defaultValue: 'All' }), count: rows.length },
    ...['new', 'open', 'pending', 'resolved', 'closed']
      .filter((s) => (counts.get(s) ?? 0) > 0)
      .map((s) => ({
        key: s,
        label: t(`status.${s}`, { ns: 'common', defaultValue: s }),
        count: counts.get(s) ?? 0,
      })),
  ];

  const visible = statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter);
  const { sorted, sort, toggle } = useTableSort(visible, REGISTER_SORT);

  const pageCount = Math.max(1, Math.ceil(sorted.length / REGISTER_PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = sorted.slice((current - 1) * REGISTER_PAGE_SIZE, current * REGISTER_PAGE_SIZE);
  const onSort = (key: string) => {
    toggle(key);
    setPage(1);
  };
  const sortProps = (key: string, align?: 'start' | 'end') => ({
    active: sort?.key === key,
    dir: sort?.dir ?? ('asc' as const),
    onSort: () => onSort(key),
    align,
  });

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('ticketOps.register', { defaultValue: 'Ticket register' })}
        </h3>
        {/* Status filter tabs with colored dots + live counts. */}
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map((tb) => {
            const on = statusFilter === tb.key;
            return (
              <button
                key={tb.key}
                type="button"
                onClick={() => {
                  setStatusFilter(tb.key);
                  setPage(1);
                  setOpenId(null);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-fast',
                  on
                    ? 'bg-card text-foreground shadow-soft ring-1 ring-foreground/10'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {tb.key !== 'all' && (
                  <span
                    className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[tb.key] ?? 'bg-slate-400')}
                    aria-hidden
                  />
                )}
                <span>{tb.label}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    on ? 'text-muted-foreground' : 'text-muted-foreground/70',
                  )}
                >
                  {tb.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <TableSurface>
        <Table>
          <thead>
            <tr>
              <SortTh {...sortProps('ticket')}>
                {t('ticketOps.colTicket', { defaultValue: 'Ticket' })}
              </SortTh>
              <SortTh {...sortProps('priority')}>
                {t('ticketOps.colPriority', { defaultValue: 'Priority' })}
              </SortTh>
              <SortTh {...sortProps('status')}>
                {t('ticketOps.colStatus', { defaultValue: 'Status' })}
              </SortTh>
              <SortTh {...sortProps('agent')}>
                {t('ticketOps.colAgent', { defaultValue: 'Agent' })}
              </SortTh>
              <SortTh {...sortProps('created')}>
                {t('ticketOps.colCreated', { defaultValue: 'Created' })}
              </SortTh>
              <SortTh {...sortProps('firstResponse')}>
                {t('ticketOps.colFirstResponse', { defaultValue: '1st response' })}
              </SortTh>
              <SortTh {...sortProps('resolved')}>
                {t('ticketOps.colResolved', { defaultValue: 'Resolved' })}
              </SortTh>
              <SortTh {...sortProps('age', 'end')}>
                {t('ticketOps.colAge', { defaultValue: 'Age' })}
              </SortTh>
              <Th className="text-end">{t('ticketOps.colActions', { defaultValue: 'Actions' })}</Th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const linkable = !!r.customerId && !!r.yijiVendorId;
              const open = openId === r.id;
              const toggle = () => linkable && setOpenId(open ? null : r.id);
              return (
                <Fragment key={r.id}>
                  <Tr
                    onClick={toggle}
                    className={cn(linkable ? 'cursor-pointer' : '', open && 'bg-primary/[0.08]')}
                  >
                    {/* Ticket + who it's for (two-line). */}
                    <Td className="max-w-[16rem]">
                      <Stacked
                        primary={
                          <span className="font-medium" title={r.subject}>
                            {r.subject}
                          </span>
                        }
                        secondary={r.contactName !== '—' ? r.contactName : undefined}
                      />
                    </Td>
                    <Td>
                      <Pill tone={PRIORITY_TONE[r.priority] ?? 'neutral'} size="sm" dot>
                        {t(`priority.${r.priority}`, { ns: 'common', defaultValue: r.priority })}
                      </Pill>
                    </Td>
                    <Td>
                      <Pill tone={STATUS_TONE[r.status] ?? 'neutral'} size="sm" dot>
                        {t(`status.${r.status}`, { ns: 'common', defaultValue: r.status })}
                      </Pill>
                    </Td>
                    {/* Agent + team (two-line). */}
                    <Td>
                      <span className="flex items-center gap-2">
                        <Avatar name={r.agentName} size="xs" />
                        <Stacked
                          primary={<span className="truncate">{r.agentName}</span>}
                          secondary={r.teamName !== '—' ? r.teamName : undefined}
                        />
                      </span>
                    </Td>
                    {/* Created date + time (two-line). */}
                    <Td className="tabular-nums">
                      <Stacked
                        primary={fmtDateOnly(r.created)}
                        secondary={fmtTimeOnly(r.created)}
                      />
                    </Td>
                    <Td className="tabular-nums text-muted-foreground">
                      {r.firstRespondedAt ? fmtDuration(r.responseMinutes) : '—'}
                    </Td>
                    {/* Resolved date + time (two-line). */}
                    <Td className="tabular-nums">
                      {r.resolvedAt ? (
                        <Stacked
                          primary={fmtDateOnly(r.resolvedAt)}
                          secondary={fmtTimeOnly(r.resolvedAt)}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td className="text-end tabular-nums">
                      {r.overdue ? (
                        <span className="font-semibold text-destructive">
                          {t('ticketOps.overdue', { defaultValue: 'Overdue' })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{fmtAge(r.ageHours)}</span>
                      )}
                    </Td>
                    {/* Actions — view the linked order. */}
                    <Td className="text-end">
                      {linkable ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle();
                          }}
                          aria-label={t('ticketOps.viewOrder', { defaultValue: 'View order' })}
                          className={cn(
                            'inline-grid h-8 w-8 place-items-center rounded-lg transition-colors duration-fast',
                            open
                              ? 'bg-primary/15 text-primary'
                              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                          )}
                        >
                          <EyeIcon />
                        </button>
                      ) : (
                        <span className="text-2xs text-muted-foreground/60">—</span>
                      )}
                    </Td>
                  </Tr>
                  {open && linkable && (
                    <tr>
                      <td colSpan={9} className="bg-secondary/30 px-4 py-3">
                        <TicketOrderCard
                          vendorId={r.yijiVendorId as string}
                          customerId={r.customerId as string}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </TableSurface>
      <Pagination
        page={current}
        pageCount={pageCount}
        onPage={setPage}
        prevLabel={t('ticketOps.prev', { defaultValue: 'Previous' })}
        nextLabel={t('ticketOps.next', { defaultValue: 'Next' })}
        className="px-1"
      />
    </div>
  );
}

/** Linked customer order for a ticket — lazily fetched on expand. */
function TicketOrderCard({ vendorId, customerId }: { vendorId: string; customerId: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['ticket-order', vendorId, customerId],
    staleTime: 60_000,
    queryFn: async () => {
      const list = await commerce.getOrders(vendorId, customerId, { limit: 1 });
      const summary = list?.[0];
      if (!summary) return null;
      const full = await commerce.getOrder(vendorId, summary.orderId).catch(() => null);
      return full ?? summary;
    },
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('ticketOps.noOrder', { defaultValue: 'No linked order for this customer.' })}
      </p>
    );
  }
  const o = q.data;
  const restaurant = [o.brandName, o.restaurantName].filter(Boolean).join(' — ');

  return (
    <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('ticketOps.linkedOrder', { defaultValue: 'Linked order' })}
        </span>
        <span className="font-mono text-xs text-foreground">#{o.orderId}</span>
        <Pill tone="primary" size="sm">
          {titleize(o.status)}
        </Pill>
        {o.deliveryType && (
          <Pill tone="neutral" size="sm">
            {t(`commerce.deliveryTypes.${o.deliveryType}`, {
              defaultValue: titleize(o.deliveryType),
            })}
          </Pill>
        )}
        <span className="ms-auto text-sm font-bold tabular-nums text-foreground">
          {money(o.total, o.currency)}
        </span>
      </div>

      {restaurant && <div className="mt-2 text-sm font-semibold text-foreground">{restaurant}</div>}

      {o.items && o.items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs">
          {o.items.map((it, i) => (
            <li key={it.sku || i} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="tabular-nums text-foreground/80">{it.qty}×</span> {it.name}
                {it.category && (
                  <span className="ms-1 text-2xs text-muted-foreground">· {it.category}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {money(it.price * it.qty, o.currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">
          {t('ticketOps.orderNoItems', { defaultValue: 'No line items on this order.' })}
        </p>
      )}
    </div>
  );
}

/**
 * Ticket analytics — status/priority mix and lifecycle timing.
 *
 * Extracted when the standalone Ticket report was retired so the Overview
 * dashboard could absorb it. Kept in this file next to Breakdown/Timing, which
 * it composes, rather than copied into the dashboard: two drifting copies of the
 * same panel is exactly the redundancy the merge set out to remove.
 */
export function TicketAnalytics({ data }: { data: TicketOps }) {
  const { t } = useTranslation();
  const STATUS_BAR: Record<string, string> = {
    new: 'bg-primary',
    open: 'bg-success',
    pending: 'bg-warning',
    resolved: 'bg-primary/60',
    closed: 'bg-muted-foreground/50',
  };
  const PRIORITY_BAR: Record<string, string> = {
    urgent: 'bg-destructive',
    high: 'bg-warning',
    medium: 'bg-primary',
    low: 'bg-muted-foreground/50',
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.05]">
        <Timing
          label={t('ticketOps.medianResponse', { defaultValue: 'Median 1st response' })}
          value={fmtDuration(data.timing.medianResponseMin)}
        />
        <Timing
          label={t('ticketOps.medianResolution', { defaultValue: 'Median resolution' })}
          value={fmtDuration(data.timing.medianResolutionMin)}
        />
        <Timing
          label={t('ticketOps.avgResolution', { defaultValue: 'Avg resolution' })}
          value={fmtDuration(data.timing.avgResolutionMin)}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Breakdown
          title={t('ticketOps.byStatus', { defaultValue: 'By status' })}
          items={data.byStatus}
          label={(k) => t(`status.${k}`, { ns: 'common', defaultValue: k })}
          toneClass={(k) => STATUS_BAR[k] ?? 'bg-primary'}
        />
        <Breakdown
          title={t('ticketOps.byPriority', { defaultValue: 'By priority' })}
          items={data.byPriority}
          label={(k) => t(`priority.${k}`, { ns: 'common', defaultValue: k })}
          toneClass={(k) => PRIORITY_BAR[k] ?? 'bg-primary'}
        />
      </div>
    </div>
  );
}
