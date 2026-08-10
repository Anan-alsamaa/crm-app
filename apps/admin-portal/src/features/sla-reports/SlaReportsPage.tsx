import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  EmptyState,
  Pill,
  SelectMenu,
  Spinner,
  Table,
  TableSurface,
  Td,
  Th,
  Toolbar,
  ToolbarSpacer,
  Tr,
} from '@yiji/ui';
import { useSlaReports, type SlaCell, type TicketSla } from './api.js';

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
/** Green ≥90, amber ≥75, red below (no data → blue). */
const pctKpiTone = (n: number | null): KpiTone =>
  n == null ? 'blue' : n >= 90 ? 'green' : n >= 75 ? 'amber' : 'crimson';

function Kpi({ label, value, tone = 'blue' }: { label: string; value: string; tone?: KpiTone }) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card px-4 py-4 shadow-soft ring-1 ring-border transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
      )}
    >
      <div className="text-4xl font-bold tracking-[-0.03em] tabular-nums leading-none text-foreground">
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
  const [view, setView] = useState<'agent' | 'ticket'>('agent');
  const [agentFilter, setAgentFilter] = useState<{ id: string | null; name: string } | null>(null);
  const report = useSlaReports(days);

  const ticketsShown = useMemo(() => {
    const all = report.data?.tickets ?? [];
    if (view === 'ticket' && agentFilter) return all.filter((tk) => tk.agentId === agentFilter.id);
    return all;
  }, [report.data, view, agentFilter]);

  const exportCsv = () => {
    if (!report.data) return;
    if (view === 'agent') {
      const rows: (string | number)[][] = [
        [
          'agent',
          'tickets',
          'first_response_pct',
          'fr_met',
          'fr_breached',
          'resolution_pct',
          'res_met',
          'res_breached',
          'avg_first_response_min',
          'breaches',
        ],
        ...report.data.agents.map((a) => [
          a.agentName,
          a.tickets,
          a.frPct == null ? '' : Math.round(a.frPct),
          a.frMet,
          a.frBreached,
          a.resPct == null ? '' : Math.round(a.resPct),
          a.resMet,
          a.resBreached,
          a.avgResponseMin == null ? '' : Math.round(a.avgResponseMin),
          a.breaches,
        ]),
      ];
      downloadCsv(`sla-by-agent-${days}d.csv`, rows);
    } else {
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
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('slaReports.title', { defaultValue: 'SLA reports' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t('slaReports.subtitle', {
            defaultValue: 'First-response & resolution SLA — drill from agent into tickets',
          })}
        </span>
        <ToolbarSpacer />
        {/* View toggle */}
        <div className="inline-flex rounded-lg bg-secondary/60 p-0.5 text-xs">
          {(['agent', 'ticket'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                if (v === 'agent') setAgentFilter(null);
              }}
              className={cn(
                'rounded-md px-2.5 py-1 font-medium transition-colors duration-fast',
                view === v
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v === 'agent'
                ? t('slaReports.byAgent', { defaultValue: 'By agent' })
                : t('slaReports.byTicket', { defaultValue: 'By ticket' })}
            </button>
          ))}
        </div>
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
            title={t('slaReports.empty', { defaultValue: 'No tickets in this window' })}
            description={t('slaReports.emptyHint', {
              defaultValue: 'Widen the date range, or wait for tickets with SLA targets to land.',
            })}
          />
        ) : (
          <div className="mx-auto max-w-5xl space-y-5">
            {/* KPI strip */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi
                label={t('slaReports.kpiTickets', { defaultValue: 'Tickets' })}
                value={String(totals?.tickets ?? 0)}
                tone="blue"
              />
              <Kpi
                label={t('slaReports.kpiFirstResponse', { defaultValue: 'First-response SLA' })}
                value={fmtPct(totals?.frPct ?? null)}
                tone={pctKpiTone(totals?.frPct ?? null)}
              />
              <Kpi
                label={t('slaReports.kpiResolution', { defaultValue: 'Resolution SLA' })}
                value={fmtPct(totals?.resPct ?? null)}
                tone={pctKpiTone(totals?.resPct ?? null)}
              />
              <Kpi
                label={t('slaReports.kpiBreaches', { defaultValue: 'Breaches' })}
                value={String(totals?.breaches ?? 0)}
                tone={(totals?.breaches ?? 0) > 0 ? 'crimson' : 'green'}
              />
            </div>

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
                {!agentFilter && <Td className="text-muted-foreground">{tk.agentName}</Td>}
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
      </TableSurface>
    </div>
  );
}
