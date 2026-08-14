import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  ClockIcon,
  cn,
  EmptyState,
  type MetricTone,
  Pill,
  ProgressRing,
  SelectMenu,
  ShieldIcon,
  Spinner,
  Table,
  TableFooterBar,
  TableSurface,
  Td,
  Th,
  TicketIcon,
  Toolbar,
  ToolbarSpacer,
  Tr,
  ZapIcon,
} from '@yiji/ui';
import { useSlaReports, type SlaCell, type TicketSla } from './api.js';

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

function SlaPill({ cell }: { cell: SlaCell }) {
  const { t } = useTranslation();
  const map = {
    met: { tone: 'success' as const, label: t('slaReports.met', { defaultValue: 'Met' }) },
    breached: {
      tone: 'destructive' as const,
      label: t('slaReports.breached', { defaultValue: 'Breached' }),
    },
    pending: {
      tone: 'warning' as const,
      label: t('slaReports.pending', { defaultValue: 'Pending' }),
    },
    na: { tone: 'muted' as const, label: '—' },
  };
  const { tone, label } = map[cell.state];
  const title = [
    cell.dueAt && `due ${new Date(cell.dueAt).toLocaleString()}`,
    cell.doneAt && `done ${new Date(cell.doneAt).toLocaleString()}`,
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
  /** Rendered inside a tinted rounded-square chip above the numeral. */
  icon?: ReactNode;
  /** End-aligned data accent — a `<ProgressRing>` for the % tiles. */
  visual?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06] transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
      )}
    >
      {/* Chip and ring share the top band: identity at the start, the data
          accent at the end, boards-style. */}
      {(icon || visual) && (
        <div className="mb-3 flex items-start justify-between gap-2">
          {icon && (
            <span
              aria-hidden
              className={cn('grid h-9 w-9 place-items-center rounded-lg', KPI_CHIP[tone])}
            >
              {icon}
            </span>
          )}
          {visual && <div className="ms-auto shrink-0">{visual}</div>}
        </div>
      )}
      <div className="text-4xl font-extrabold tracking-[-0.03em] tabular-nums leading-none text-foreground">
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KPI_DOT[tone])} />
        {label}
      </div>
    </div>
  );
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

export function SlaReportsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [agentFilter, setAgentFilter] = useState<{ id: string | null; name: string } | null>(null);
  const report = useSlaReports(days);

  const ticketsShown = useMemo(() => {
    const all = report.data?.tickets ?? [];
    if (agentFilter) return all.filter((tk) => tk.agentId === agentFilter.id);
    return all;
  }, [report.data, agentFilter]);

  /**
   * Exports the TICKETS, always — the same rows on screen, filtered the same
   * way. There used to be a second, per-agent shape behind the view toggle;
   * with the toggle gone it could only ever have been reached by accident, and
   * a per-agent rollup is what Agent KPI exports.
   */
  const exportCsv = () => {
    if (!report.data) return;
    {
      const rows: (string | number)[][] = [
        [
          'ticket_id',
          'subject',
          'priority',
          'status',
          'agent',
          'first_response',
          'resolution',
          'first_reply_min',
        ],
        ...ticketsShown.map((tk) => [
          tk.id,
          tk.subject,
          tk.priority,
          tk.status,
          tk.agentName,
          tk.firstResponse.state,
          tk.resolution.state,
          tk.responseMinutes == null ? '' : Math.round(tk.responseMinutes),
        ]),
      ];
      downloadCsv(`sla-by-ticket-${days}d.csv`, rows);
    }
  };

  const totals = report.data?.totals;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        {/* Title only, as the sibling report pages do — the editorial header
            below carries the subtitle, so repeating it up here made the two
            headers read as a collision. */}
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('slaReports.title', { defaultValue: 'SLA reports' })}
        </h1>
        <ToolbarSpacer />
        {/* The by-agent / by-ticket toggle that used to sit here is gone. The
            per-agent half was retired when Agent KPI took that job, so the
            toggle had one working position and switched nothing — a control
            that does nothing is worse than no control, because somebody keeps
            clicking it expecting a different answer. */}
        <div className="w-32">
          <SelectMenu
            fullWidth
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            aria-label={t('slaReports.range', { defaultValue: 'Date range' })}
            options={RANGE_DAYS.map((d) => ({
              value: String(d),
              label: t('slaReports.lastDays', {
                count: d,
                days: d,
                defaultValue: 'Last {{days}} days',
              }),
            }))}
          />
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={exportCsv} disabled={!report.data}>
          {t('slaReports.exportCsv', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {report.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : !report.data || report.data.tickets.length === 0 ? (
          <EmptyState
            icon={<TicketIcon size={22} />}
            title={t('slaReports.empty', { defaultValue: 'No tickets in this window' })}
            description={t('slaReports.emptyHint', {
              defaultValue: 'Widen the date range, or wait for tickets with SLA targets to land.',
            })}
          />
        ) : (
          <div className="mx-auto max-w-5xl space-y-5">
            {/* Clean editorial header — same anatomy as the export reports. */}
            <div className="border-b border-foreground/10 pb-5">
              <h2 className="text-3xl font-bold tracking-tight text-foreground">
                {t('slaReports.title', { defaultValue: 'SLA reports' })}
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('slaReports.subtitle', {
                  defaultValue: 'Which TICKETS met the deadline they were promised',
                })}
              </p>
            </div>

            {/* KPI strip — the % tiles carry a progress ring, boards-style: the
                numeral stays the reading, the arc makes the shortfall visible
                at a glance. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi
                label={t('slaReports.kpiTickets', { defaultValue: 'Tickets' })}
                value={String(totals?.tickets ?? 0)}
                tone="blue"
                icon={<TicketIcon size={18} />}
              />
              <Kpi
                label={t('slaReports.kpiFirstResponse', { defaultValue: 'First-response SLA' })}
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
                label={t('slaReports.kpiResolution', { defaultValue: 'Resolution SLA' })}
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
                value={String(totals?.breaches ?? 0)}
                tone={(totals?.breaches ?? 0) > 0 ? 'crimson' : 'green'}
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
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TicketTable({
  tickets,
  agentFilter,
  onClearAgent,
}: {
  tickets: TicketSla[];
  agentFilter: { id: string | null; name: string } | null;
  onClearAgent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
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
      <TableSurface>
        <Table>
          <thead>
            <tr>
              <Th>{t('slaReports.colTicket', { defaultValue: 'Ticket' })}</Th>
              <Th>{t('slaReports.colPriority', { defaultValue: 'Priority' })}</Th>
              <Th>{t('slaReports.colStatus', { defaultValue: 'Status' })}</Th>
              {!agentFilter && <Th>{t('slaReports.colAgent', { defaultValue: 'Agent' })}</Th>}
              <Th>{t('slaReports.colFirstResponse', { defaultValue: 'First response' })}</Th>
              <Th>{t('slaReports.colResolution', { defaultValue: 'Resolution' })}</Th>
              <Th className="text-end">
                {t('slaReports.colReplyTime', { defaultValue: '1st reply' })}
              </Th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((tk) => (
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
                  <SlaPill cell={tk.firstResponse} />
                </Td>
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
    </div>
  );
}
