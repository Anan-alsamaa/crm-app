import { useMemo, useState, type ReactNode } from 'react';
import { usePinnedWidth } from '../../lib/pinned-width.js';
import { ColumnScroller } from '../../components/ColumnScroller.js';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  ClockIcon,
  cn,
  EmptyState,
  ExportButtons,
  formatDateTime,
  Pill,
  ProgressRing,
  SelectMenu,
  ShieldIcon,
  Spinner,
  pageCountOf,
  Table,
  TableFooterBar,
  TablePager,
  TableSurface,
  Td,
  Th,
  TicketIcon,
  Tr,
  type MetricTone,
  ZapIcon,
} from '@yiji/ui';
import { useSlaReports, type SlaCell, type TicketSla } from './api.js';
import { exportCsv, reportFilename, type CsvColumn } from '@yiji/reports';
import { useRememberedRange, isoDay } from '../../lib/date-range.js';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';

const RANGE_DAYS = [7, 30, 90] as const;

const PRIORITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'destructive'> = {
  low: 'muted',
  medium: 'neutral',
  high: 'warning',
  urgent: 'destructive',
};
/* Board mapping, same as the export reports: open reads sky, resolved jade,
 * closed neutral. 'warning' keeps the darkened-treatment pill (warning is a
 * light token on its own). */
const STATUS_TONE: Record<
  string,
  'primary' | 'success' | 'warning' | 'muted' | 'neutral' | 'blue'
> = {
  new: 'primary',
  open: 'blue',
  pending: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

const fmtPct = (n: number | null) => (n == null ? '—' : `${Math.round(n)}%`);
const fmtMins = (n: number | null) =>
  n == null ? '—' : n < 60 ? `${Math.round(n)}m` : `${(n / 60).toFixed(1)}h`;
/** Tone for a compliance %: green ≥90, amber ≥75, red below. */

interface OutcomeName {
  tone: 'success' | 'destructive' | 'warning' | 'muted';
  /** What a row's pill says. */
  label: string;
  /** What a filter chip says, where there is no column header for context. */
  filterLabel: string;
}

/** What each SLA outcome is called, in one place. */
function useOutcomeNames(): Record<SlaCell['state'], OutcomeName> {
  const { t } = useTranslation();
  return {
    met: {
      tone: 'success',
      label: String(t('slaReports.met', { defaultValue: 'Met' })),
      filterLabel: String(t('slaReports.met', { defaultValue: 'Met' })),
    },
    breached: {
      tone: 'destructive',
      label: String(t('slaReports.breached', { defaultValue: 'Breached' })),
      filterLabel: String(t('slaReports.breached', { defaultValue: 'Breached' })),
    },
    pending: {
      tone: 'warning',
      label: String(t('slaReports.pending', { defaultValue: 'Pending' })),
      filterLabel: String(t('slaReports.pending', { defaultValue: 'Pending' })),
    },
    // An em dash is right INSIDE a row, where the column header supplies the
    // context. On a filter chip it says nothing, so the state gets its real
    // name there.
    na: {
      tone: 'muted',
      label: '—',
      filterLabel: String(t('slaReports.naFilter', { defaultValue: 'No target' })),
    },
  };
}

function SlaPill({ cell }: { cell: SlaCell }) {
  const map = useOutcomeNames();
  const { tone, label } = map[cell.state];
  const title = [
    cell.dueAt && `due ${formatDateTime(cell.dueAt)}`,
    cell.doneAt && `done ${formatDateTime(cell.doneAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span title={title || undefined}>
      <Pill tone={tone} size="sm">
        {label}
      </Pill>
    </span>
  );
}

/* Vibrant tinted KPI card — matches the Ticket report / export reports. */
type KpiTone = 'blue' | 'green' | 'amber' | 'crimson';
/* Colour as ACCENT, not surface. Solid saturated tiles read as a toy dashboard
 * (and here the numeral was the SAME colour as its fill — invisible). White
 * card + ink numeral is also the strongest contrast available (~19.5:1); the
 * tone survives as a state-indicator dot, which is what SLA green/amber/red
 * actually is. */
const KPI_DOT: Record<KpiTone, string> = {
  blue: 'bg-sky',
  green: 'bg-success',
  amber: 'bg-warning',
  crimson: 'bg-destructive',
};
/* Icon chips take tint + hue token pairs, same anatomy as the export reports'
 * tiles; amber stays NEUTRAL — warning is a light token and a warning-tinted
 * chip fails contrast on the light theme. */
const KPI_CHIP: Record<KpiTone, string> = {
  blue: 'bg-sky-tint text-sky',
  green: 'bg-success-tint text-success',
  amber: 'bg-secondary text-muted-foreground',
  crimson: 'bg-destructive-tint text-destructive',
};
/** Green ≥90, amber ≥75, red below (no data → blue). */
const pctKpiTone = (n: number | null): KpiTone =>
  n == null ? 'blue' : n >= 90 ? 'green' : n >= 75 ? 'amber' : 'crimson';
/* Ring accents for the % tiles. MetricTone deliberately has no warning/amber
 * (a light token), so the amber band falls back to jade. */
/* The SURFACE carries the hue, like every other report's tiles — this page
 * was the last one left showing four white boxes. */
const KPI_SURFACE: Record<KpiTone, string> = {
  blue: 'bg-gradient-to-br from-sky-tint/70 to-card',
  green: 'bg-gradient-to-br from-success-tint/70 to-card',
  amber: 'bg-gradient-to-br from-warning-tint/70 to-card',
  crimson: 'bg-gradient-to-br from-destructive-tint/70 to-card',
};
const KPI_NUMERAL: Record<KpiTone, string> = {
  blue: 'text-[oklch(0.48_0.16_264)]',
  green: 'text-[oklch(0.45_0.13_155)]',
  amber: 'text-[oklch(0.5_0.13_75)]',
  crimson: 'text-destructive',
};

const RING_TONE: Record<KpiTone, MetricTone> = {
  blue: 'sky',
  green: 'success',
  amber: 'primary',
  crimson: 'destructive',
};

function Kpi({
  label,
  value,
  tone = 'blue',
  icon,
  visual,
}: {
  label: string;
  value: string;
  tone?: KpiTone;
  /** Rendered in a tinted rounded-square chip at the start of the line. */
  icon?: ReactNode;
  /** End-aligned data accent — a `<ProgressRing>` for the % tiles. */
  visual?: ReactNode;
}) {
  return (
    <div
      className={cn(
        // ONE LINE, matching @yiji/ui's ReportKpi.
        //
        // These four opened this report at ~150px — a chip row, a 4xl numeral
        // and a label, stacked. With the toolbar, the description and a
        // two-row filter bar above them, the table began 560px down and
        // floored at its minimum on a 900px screen. This report keeps its OWN
        // tile rather than using the shared one because it needs a `crimson`
        // tone the shared vocabulary has no seat for, and red for a badly
        // missed SLA is the whole point of colouring these at all.
        'flex items-center gap-3 rounded-xl px-3.5 py-2.5',
        'shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_10px_26px_-14px_oklch(var(--shadow-color)/0.18)]',
        'transition-[box-shadow] duration-base ease-out',
        KPI_SURFACE[tone],
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', KPI_CHIP[tone])}
        >
          {icon}
        </span>
      )}
      <div
        data-kpi-value
        className={cn(
          'shrink-0 text-2xl font-extrabold leading-none tabular-nums tracking-[-0.03em]',
          KPI_NUMERAL[tone],
        )}
      >
        {value}
      </div>
      <div
        data-kpi-label
        className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase leading-tight tracking-[0.1em] text-muted-foreground"
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KPI_DOT[tone])} />
        <span className="min-w-0">{label}</span>
      </div>
      {visual && <div className="ms-auto shrink-0">{visual}</div>}
    </div>
  );
}

/* The CSV writer that used to live here is gone. It emitted no UTF-8 BOM, so
 * Excel read every Arabic subject and agent name as the local codepage and
 * showed mojibake; it joined rows with a bare newline; and it did not neutralise
 * a leading "=" in a customer-typed subject. @yiji/reports/csv does all three,
 * and does them the same way for all five reports. */

export function SlaReportsPage() {
  const { t } = useTranslation();
  const pinRef = usePinnedWidth();
  const {
    from,
    to,
    setFrom,
    setTo,
    setRange,
    reset: resetRange,
  } = useRememberedRange('sara.reports.range');
  /** Days the range covers — the export file name says the period. */
  const days = useMemo(() => {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return Number.isFinite(a) && Number.isFinite(b)
      ? Math.max(1, Math.round((b - a) / 86_400_000))
      : 30;
  }, [from, to]);
  const [agentFilter, setAgentFilter] = useState<{ id: string | null; name: string } | null>(null);
  /**
   * Search and outcome live HERE rather than inside the table, because the
   * export reads from the same value. A filter the table owned privately would
   * produce a file that disagreed with the screen that asked for it.
   */
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<'all' | SlaCell['state']>('all');
  const [priority, setPriority] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const report = useSlaReports(days, { from, to });

  const ticketsShown = useMemo(() => {
    const all = report.data?.tickets ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((tk) => {
      if (agentFilter && tk.agentId !== agentFilter.id) return false;
      if (outcome !== 'all' && tk.resolution.state !== outcome) return false;
      if (priority && tk.priority !== priority) return false;
      if (statusFilter && tk.status !== statusFilter) return false;
      if (!q) return true;
      return (
        tk.subject.toLowerCase().includes(q) ||
        tk.agentName.toLowerCase().includes(q) ||
        tk.id.toLowerCase().includes(q)
      );
    });
  }, [report.data, agentFilter, query, outcome, priority, statusFilter]);

  /** Options built from the rows in range, never from an enum. */
  const optionsOf = (pick: (tk: TicketSla) => string) =>
    [...new Set((report.data?.tickets ?? []).map(pick).filter(Boolean))].sort();

  /** Outcome tabs with counts, taken from the set BEFORE the outcome filter —
   *  a count that moves as you filter by it tells you nothing. */
  const outcomeCounts = useMemo(() => {
    const base = (report.data?.tickets ?? []).filter(
      (tk) => !agentFilter || tk.agentId === agentFilter.id,
    );
    const m = new Map<string, number>();
    for (const tk of base) m.set(tk.resolution.state, (m.get(tk.resolution.state) ?? 0) + 1);
    return { base: base.length, entries: [...m.entries()].sort((a, b) => b[1] - a[1]) };
  }, [report.data, agentFilter]);

  /**
   * Exports the TICKETS, always — the same rows on screen, filtered the same
   * way. There used to be a second, per-agent shape behind the view toggle;
   * with the toggle gone it could only ever have been reached by accident, and
   * a per-agent rollup is what Agent KPI exports.
   */
  /** The columns of the table, as the file. Same order, same headings. */
  const csvColumns: CsvColumn<TicketSla>[] = [
    { header: t('slaReports.colTicket', { defaultValue: 'Ticket' }), value: (tk) => tk.subject },
    {
      header: t('slaReports.colPriority', { defaultValue: 'Priority' }),
      value: (tk) =>
        String(t(`priority.${tk.priority}`, { ns: 'common', defaultValue: tk.priority })),
    },
    {
      header: t('slaReports.colStatus', { defaultValue: 'Status' }),
      value: (tk) => String(t(`status.${tk.status}`, { ns: 'common', defaultValue: tk.status })),
    },
    { header: t('slaReports.colAgent', { defaultValue: 'Agent' }), value: (tk) => tk.agentName },
    {
      header: t('slaReports.colResolution', { defaultValue: 'Resolution' }),
      value: (tk) =>
        String(t(`slaReports.${tk.resolution.state}`, { defaultValue: tk.resolution.state })),
    },
    {
      header: t('slaReports.colReplyTime', { defaultValue: '1st reply' }),
      // Minutes as a number, so the column can be averaged in a spreadsheet.
      value: (tk) => (tk.responseMinutes == null ? null : Math.round(tk.responseMinutes)),
    },
    { header: t('slaReports.colTicketId', { defaultValue: 'Ticket id' }), value: (tk) => tk.id },
  ];

  const runExport = (scope: 'view' | 'all') => {
    const rowsOut = scope === 'all' ? (report.data?.tickets ?? []) : ticketsShown;
    if (rowsOut.length === 0) return;
    exportCsv(reportFilename('SLA by ticket', days, 'csv'), csvColumns, rowsOut);
  };

  const totals = report.data?.totals;
  /**
   * Breaches the reader can actually reach.
   *
   * report.totals.breaches adds first-response breaches to resolution ones, but
   * a ticket is raised out of a conversation that was already answered, so this
   * report does not judge its first response at all — there is no such column.
   * Counting them in the headline made the tile disagree with every row beneath
   * it, and with the filter chip that selects them.
   */
  const resolutionBreaches = useMemo(
    () => (report.data?.tickets ?? []).filter((tk) => tk.resolution.state === 'breached').length,
    [report.data],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* NO VERTICAL PADDING ON THE SCROLLPORT.
                 `position: sticky; top: 0` pins to the scrollport's CONTENT
                 box, so 20px of padding here left a 20px band above the pinned
                 header with rows sliding through it — a strip of half-visible
                 checkboxes over the column names. The spacing moves inside,
                 where it is spacing rather than a gap in the sticky ceiling. */}
      {/* A VISIBLE horizontal bar.
                 The app's global scrollbar thumb is deliberately faint, which
                 is right for a page and wrong for the one control that reaches
                 half a report's columns — at 12px and near-transparent at the
                 very foot of the window it was easy to miss that the table
                 continued at all. Paired with <ColumnScroller/>, which says how
                 many columns are hidden and pages through them. */}
      <div
        ref={pinRef}
        className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] flex-1 overflow-auto px-4 py-0 sm:px-6 lg:px-8"
      >
        {/* OUTSIDE the loading / empty / loaded branch, so the page identifies
            itself in all three states.
            It used to live in a toolbar, which rendered whatever the query was
            doing; folding the toolbar away put the name inside the loaded
            branch only, and a page that is still fetching became a spinner in
            an unnamed rectangle. */}
        {/* Name and purpose on ONE line.
            They were three bands — a 60px toolbar carrying the name, a
            paragraph carrying the purpose, and the gaps — on a page whose
            table already floored at its minimum on a 900px screen. The
            name stays as a real h1: the tab strip above shows it as a
            selected pill, but a pill is not a heading. */}
        <div className="sticky start-0 flex w-[var(--pin-w,100%)] flex-wrap items-baseline gap-x-3 gap-y-1 pt-4 sm:pt-5">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">
            {t('slaReports.title', { defaultValue: 'Ticket deadlines' })}
          </h1>
          <p className="min-w-0 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('slaReports.subtitle', {
              defaultValue: 'Which tickets were finished by the time they were promised.',
            })}
          </p>
        </div>

        {report.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : !report.data ? (
          <EmptyState
            icon={<TicketIcon size={22} />}
            title={t('slaReports.empty', { defaultValue: 'No tickets in this window' })}
            description={t('slaReports.emptyHint', {
              defaultValue: 'Widen the date range, or wait for tickets with SLA targets to land.',
            })}
          />
        ) : (
          <div className="mt-3 w-max min-w-full space-y-3 pb-4 sm:pb-5">
            {/* KPI strip — the % tiles carry a progress ring, boards-style: the
                numeral stays the reading, the arc makes the shortfall visible
                at a glance. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi
                label={t('slaReports.kpiTickets', { defaultValue: 'Tickets' })}
                value={String(totals?.tickets ?? 0)}
                tone="blue"
                icon={<TicketIcon size={18} />}
              />
              <Kpi
                label={t('slaReports.kpiFirstResponse', {
                  defaultValue: 'Chat first response',
                })}
                value={fmtPct(totals?.frPct ?? null)}
                tone={pctKpiTone(totals?.frPct ?? null)}
                icon={<ZapIcon size={18} />}
                visual={
                  totals?.frPct != null ? (
                    <ProgressRing value={totals.frPct} tone={RING_TONE[pctKpiTone(totals.frPct)]} />
                  ) : undefined
                }
              />
              <Kpi
                label={t('slaReports.kpiResolution', { defaultValue: 'Ticket time to solve' })}
                value={fmtPct(totals?.resPct ?? null)}
                tone={pctKpiTone(totals?.resPct ?? null)}
                icon={<ClockIcon size={18} />}
                visual={
                  totals?.resPct != null ? (
                    <ProgressRing
                      value={totals.resPct}
                      tone={RING_TONE[pctKpiTone(totals.resPct)]}
                    />
                  ) : undefined
                }
              />
              <Kpi
                label={t('slaReports.kpiBreaches', { defaultValue: 'Breaches' })}
                value={String(resolutionBreaches)}
                tone={resolutionBreaches > 0 ? 'crimson' : 'green'}
                icon={<ShieldIcon size={18} />}
              />
            </div>

            {/* Says which question this report answers and which it does not.
                Three surfaces now report response times — this one, Agent KPI,
                and Agent performance — and the numbers will never match,
                because they measure different things over different objects.
                An unlabelled discrepancy reads as a bug in whichever one the
                reader trusts least. */}
            <p className="rounded-xl bg-secondary/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              {t('slaReports.scopeNote', {
                defaultValue:
                  'One row per TICKET, judged against the deadline its SLA policy promised. Use it to find the breaches and who held them. For a per-agent rollup with CSAT see Agent KPI; for chat response times see Agent performance — those measure conversations, not tickets, so their numbers are not these ones.',
              })}
            </p>
            {/* ONE table. This page used to toggle between a per-agent view and a
                per-ticket view, and the per-agent one duplicated the Agent KPI
                report. SLA performance is about which TICKETS met their promise,
                so the ticket table is the one that belongs here; per-agent
                performance lives in Agent KPI. */}
            <TicketTable
              tickets={ticketsShown}
              agentFilter={agentFilter}
              onClearAgent={() => setAgentFilter(null)}
              query={query}
              onQuery={setQuery}
              outcome={outcome}
              onOutcome={setOutcome}
              outcomeCounts={outcomeCounts}
              rangePreset={
                <SelectMenu
                  fullWidth
                  value=""
                  onChange={(v) => {
                    const n = Number(v);
                    const now = new Date();
                    setRange({
                      from: isoDay(new Date(now.getTime() - n * 86_400_000)),
                      to: isoDay(now),
                    });
                  }}
                  aria-label={t('slaReports.range', { defaultValue: 'Date range' })}
                  options={[
                    {
                      value: '',
                      label: t('agentReports.presets', { defaultValue: 'Quick range' }),
                    },
                    ...RANGE_DAYS.map((d) => ({
                      value: String(d),
                      label: String(
                        t('slaReports.lastDays', {
                          count: d,
                          days: d,
                          defaultValue: 'Last {{days}} days',
                        }),
                      ),
                    })),
                  ]}
                />
              }
              exportAction={
                /* Secondary, like the export on every other report. It was
                   `ghost` here, so the same action looked like a different
                   weight of thing depending on which report you stood in. */
                <ExportButtons
                  visibleCount={ticketsShown.length}
                  totalCount={report.data?.tickets.length ?? 0}
                  onExportView={() => runExport('view')}
                  onExportAll={() => runExport('all')}
                  disabled={!report.data}
                  labelPlain={t('agentReports.exportCsvCount', {
                    count: ticketsShown.length,
                    defaultValue: 'Export CSV ({{count}})',
                  })}
                  labelView={t('agentReports.exportCsvFiltered', {
                    count: ticketsShown.length,
                    defaultValue: 'Export {{count}} shown',
                  })}
                  labelAll={t('agentReports.exportCsvAll', {
                    count: report.data?.tickets.length ?? 0,
                    defaultValue: 'Export all {{count}}',
                  })}
                />
              }
              bar={{
                from,
                to,
                setFrom,
                setTo,
                priority,
                setPriority,
                status: statusFilter,
                setStatus: setStatusFilter,
                priorityOptions: optionsOf((tk) => tk.priority),
                statusOptions: optionsOf((tk) => tk.status),
                filtering: Boolean(query.trim() || priority || statusFilter),
                onClear: () => {
                  setQuery('');
                  setPriority('');
                  setStatusFilter('');
                  setOutcome('all');
                  resetRange();
                },
              }}
            />
          </div>
        )}
        <ColumnScroller portRef={pinRef} />
      </div>
    </div>
  );
}

/** An outcome tab with its count — the same anatomy the other reports use. */
function OutcomeChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-fast',
        active
          ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
          : 'text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function TicketTable({
  tickets,
  agentFilter,
  onClearAgent,
  query,
  onQuery,
  outcome,
  onOutcome,
  outcomeCounts,
  rangePreset,
  exportAction,
  bar,
}: {
  tickets: TicketSla[];
  agentFilter: { id: string | null; name: string } | null;
  onClearAgent: () => void;
  query: string;
  onQuery: (v: string) => void;
  outcome: 'all' | SlaCell['state'];
  onOutcome: (v: 'all' | SlaCell['state']) => void;
  outcomeCounts: { base: number; entries: [string, number][] };
  /**
   * The "last 7 / 30 / 90 days" shortcut, handed down so it can be rendered
   * INSIDE the filter bar beside the two dates it writes. It used to sit in a
   * toolbar of its own, whose only other content was the report's name — which
   * the tab strip above it already shows as a selected pill.
   */
  rangePreset: ReactNode;
  /**
   * Export, rendered on the filter bar's own line.
   *
   * It lived in the toolbar that is gone. What it writes is whatever the
   * controls beside it have narrowed to, so putting the two together says so —
   * and it costs no band of its own.
   */
  exportAction: ReactNode;
  bar: {
    from: string;
    to: string;
    setFrom: (v: string) => void;
    setTo: (v: string) => void;
    priority: string;
    setPriority: (v: string) => void;
    status: string;
    setStatus: (v: string) => void;
    priorityOptions: string[];
    statusOptions: string[];
    onClear: () => void;
    filtering: boolean;
  };
}) {
  const { t } = useTranslation();
  const outcomeNames = useOutcomeNames();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pageCount = pageCountOf(tickets.length, pageSize);
  const current = Math.min(page, pageCount);
  const pageRows = tickets.slice((current - 1) * pageSize, current * pageSize);

  return (
    <div className="space-y-4">
      {/* The filter bar. This report used to render EVERY ticket in the window
          with no search, no filter and no pager — ninety days of tickets as one
          unbroken scroll, where the only way to find a breach was the browser's
          own find-in-page. */}
      <ReportFilterBar
        searchLabel={t('slaReports.search', { defaultValue: 'Search subject or agent' })}
        searchPlaceholder={t('slaReports.searchHint', {
          defaultValue: 'Ticket subject, agent or id',
        })}
        search={query}
        onSearch={(v) => {
          onQuery(v);
          setPage(1);
        }}
        from={bar.from}
        to={bar.to}
        onFrom={bar.setFrom}
        onTo={bar.setTo}
        selects={[
          {
            key: 'status',
            label: t('slaReports.colStatus', { defaultValue: 'Status' }),
            value: bar.status,
            onChange: (v) => {
              bar.setStatus(v);
              setPage(1);
            },
            options: bar.statusOptions.map((v) => ({
              value: v,
              label: String(t(`status.${v}`, { ns: 'common', defaultValue: v })),
            })),
          },
          {
            key: 'priority',
            label: t('slaReports.colPriority', { defaultValue: 'Priority' }),
            value: bar.priority,
            onChange: (v) => {
              bar.setPriority(v);
              setPage(1);
            },
            options: bar.priorityOptions.map((v) => ({
              value: v,
              label: String(t(`priority.${v}`, { ns: 'common', defaultValue: v })),
            })),
          },
        ]}
        filtering={bar.filtering}
        onClear={() => {
          bar.onClear();
          setPage(1);
        }}
        rangePreset={rangePreset}
        actions={exportAction}
      />

      {/* The outcome tabs stay chips: four states with live counts is a thing
          to glance at and press, not a dropdown to open. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <OutcomeChip
            label={String(t('agentReports.statusAll', { defaultValue: 'All' }))}
            count={outcomeCounts.base}
            active={outcome === 'all'}
            onClick={() => {
              onOutcome('all');
              setPage(1);
            }}
          />
          {outcomeCounts.entries.map(([k, n]) => (
            <OutcomeChip
              key={k}
              label={outcomeNames[k as SlaCell['state']].filterLabel}
              count={n}
              active={outcome === k}
              onClick={() => {
                onOutcome(k as SlaCell['state']);
                setPage(1);
              }}
            />
          ))}
        </div>
      </div>

      {agentFilter && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t('slaReports.filteredBy', { defaultValue: 'Agent:' })}
          </span>
          <button
            type="button"
            onClick={onClearAgent}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary-subtle px-2.5 py-1 font-medium text-primary hover:bg-primary-subtle/70"
          >
            {agentFilter.name}
            <span aria-hidden>✕</span>
          </button>
          <span className="text-muted-foreground">{tickets.length}</span>
        </div>
      )}

      <TableSurface
        flow
        scrollLabel={String(t('slaReports.title', { defaultValue: 'Ticket deadlines' }))}
      >
        <Table>
          <thead>
            <tr>
              <Th>{t('slaReports.colTicket', { defaultValue: 'Ticket' })}</Th>
              <Th>{t('slaReports.colPriority', { defaultValue: 'Priority' })}</Th>
              <Th>{t('slaReports.colStatus', { defaultValue: 'Status' })}</Th>
              {!agentFilter && <Th>{t('slaReports.colAgent', { defaultValue: 'Agent' })}</Th>}
              {/* No first-response column for TICKETS. A ticket is raised out
                  of a conversation that has already been answered, so a
                  first-response deadline here re-judges a reply that happened
                  before the ticket existed — and reads as a breach nobody
                  could have prevented. Chats keep both measures, where the
                  first reply IS the promise. */}
              <Th>{t('slaReports.colResolution', { defaultValue: 'Resolution' })}</Th>
              <Th className="text-end">
                {t('slaReports.colReplyTime', { defaultValue: '1st reply' })}
              </Th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <Tr>
                <Td
                  colSpan={agentFilter ? 5 : 6}
                  className="py-10 text-center text-muted-foreground"
                >
                  {t('slaReports.noneInRange', {
                    defaultValue: 'No tickets match these filters. Widen the dates, or clear them.',
                  })}
                </Td>
              </Tr>
            )}
            {pageRows.map((tk) => (
              <Tr key={tk.id}>
                <Td className="max-w-[16rem] truncate font-medium" title={tk.subject}>
                  {tk.subject}
                </Td>
                <Td>
                  <Pill tone={PRIORITY_TONE[tk.priority] ?? 'neutral'} size="sm">
                    {t(`priority.${tk.priority}`, { ns: 'common', defaultValue: tk.priority })}
                  </Pill>
                </Td>
                <Td>
                  <Pill tone={STATUS_TONE[tk.status] ?? 'neutral'} size="sm">
                    {t(`status.${tk.status}`, { ns: 'common', defaultValue: tk.status })}
                  </Pill>
                </Td>
                {!agentFilter && (
                  <Td className="text-muted-foreground">
                    {/* Avatar chip, boards-style — same anatomy as the export
                        reports' contact cells. */}
                    <span className="flex items-center gap-2">
                      <Avatar size="xs" name={tk.agentName} />
                      <span className="min-w-0 truncate">{tk.agentName}</span>
                    </span>
                  </Td>
                )}
                <Td>
                  <SlaPill cell={tk.resolution} />
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {fmtMins(tk.responseMinutes)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {/* Footer aggregate band — the count reads as part of the table it
            describes, boards-style. Reuses the KPI tile's label so the band
            adds no new strings. */}
        <TableFooterBar>
          <span className="flex items-baseline gap-1.5">
            <span className="font-semibold tabular-nums text-foreground">{tickets.length}</span>
            <span className="text-2xs font-semibold uppercase tracking-[0.12em]">
              {t('slaReports.kpiTickets', { defaultValue: 'Tickets' })}
            </span>
          </span>
        </TableFooterBar>
      </TableSurface>

      <TablePager
        page={current}
        onPage={setPage}
        pageSize={pageSize}
        onPageSize={setPageSize}
        total={tickets.length}
        pageSizes={[10, 25, 50, 100, 250, 500]}
        labels={{
          rowsPerPage: String(t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' })),
          previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
          next: String(t('agentReports.next', { defaultValue: 'Next' })),
          showing: ({ from, to, total }) =>
            String(
              t('complaintReport.showingRange', {
                defaultValue: 'Showing {{from}}-{{to}} of {{total}}',
                from,
                to,
                total,
              }),
            ),
        }}
      />
    </div>
  );
}
