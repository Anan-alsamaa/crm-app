import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  EmptyState,
  Pill,
  SelectMenu,
  Spinner,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { useSlaReports, type AgentSla, type SlaCell, type TicketSla } from './api.js';

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
const pctTone = (n: number | null) =>
  n == null
    ? 'text-muted-foreground'
    : n >= 90
      ? 'text-success'
      : n >= 75
        ? 'text-warning-foreground'
        : 'text-destructive';

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

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 ring-1 ring-border/60">
      <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1 text-2xl font-bold tracking-tight tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

  const drillToAgent = (a: AgentSla) => {
    setAgentFilter({ id: a.agentId, name: a.agentName });
    setView('ticket');
  };

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
              label: t('slaReports.lastDays', { count: d, defaultValue: `Last ${d} days` }),
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
              />
              <Kpi
                label={t('slaReports.kpiFirstResponse', { defaultValue: 'First-response SLA' })}
                value={fmtPct(totals?.frPct ?? null)}
                tone={pctTone(totals?.frPct ?? null)}
              />
              <Kpi
                label={t('slaReports.kpiResolution', { defaultValue: 'Resolution SLA' })}
                value={fmtPct(totals?.resPct ?? null)}
                tone={pctTone(totals?.resPct ?? null)}
              />
              <Kpi
                label={t('slaReports.kpiBreaches', { defaultValue: 'Breaches' })}
                value={String(totals?.breaches ?? 0)}
                tone={(totals?.breaches ?? 0) > 0 ? 'text-destructive' : 'text-success'}
              />
            </div>

            {view === 'agent' ? (
              <AgentTable agents={report.data.agents} onDrill={drillToAgent} />
            ) : (
              <TicketTable
                tickets={ticketsShown}
                agentFilter={agentFilter}
                onClearAgent={() => {
                  setAgentFilter(null);
                  setView('agent');
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HeadCell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-start text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  );
}

function AgentTable({ agents, onDrill }: { agents: AgentSla[]; onDrill: (a: AgentSla) => void }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
      <table className="w-full text-sm">
        <thead className="border-b border-border/60">
          <tr>
            <HeadCell>{t('slaReports.colAgent', { defaultValue: 'Agent' })}</HeadCell>
            <HeadCell className="text-end">
              {t('slaReports.colTickets', { defaultValue: 'Tickets' })}
            </HeadCell>
            <HeadCell className="text-end">
              {t('slaReports.colFirstResponse', { defaultValue: 'First response' })}
            </HeadCell>
            <HeadCell className="text-end">
              {t('slaReports.colResolution', { defaultValue: 'Resolution' })}
            </HeadCell>
            <HeadCell className="text-end">
              {t('slaReports.colAvgReply', { defaultValue: 'Avg 1st reply' })}
            </HeadCell>
            <HeadCell className="text-end">
              {t('slaReports.colBreaches', { defaultValue: 'Breaches' })}
            </HeadCell>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {agents.map((a) => (
            <tr
              key={a.agentId ?? '__unassigned__'}
              onClick={() => onDrill(a)}
              className="cursor-pointer transition-colors duration-fast hover:bg-secondary/50"
            >
              <td className="px-3 py-2.5 font-medium text-foreground">{a.agentName}</td>
              <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                {a.tickets}
              </td>
              <td className="px-3 py-2.5 text-end tabular-nums">
                <span className={cn('font-semibold', pctTone(a.frPct))}>{fmtPct(a.frPct)}</span>
                <span className="ms-1.5 text-2xs text-muted-foreground">
                  {a.frMet}/{a.frMet + a.frBreached}
                </span>
              </td>
              <td className="px-3 py-2.5 text-end tabular-nums">
                <span className={cn('font-semibold', pctTone(a.resPct))}>{fmtPct(a.resPct)}</span>
                <span className="ms-1.5 text-2xs text-muted-foreground">
                  {a.resMet}/{a.resMet + a.resBreached}
                </span>
              </td>
              <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                {fmtMins(a.avgResponseMin)}
              </td>
              <td className="px-3 py-2.5 text-end tabular-nums">
                <span
                  className={
                    a.breaches > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'
                  }
                >
                  {a.breaches}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-2xs text-muted-foreground">
        {t('slaReports.drillHint', { defaultValue: 'Click an agent to see their tickets.' })}
      </p>
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
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
        <table className="w-full text-sm">
          <thead className="border-b border-border/60">
            <tr>
              <HeadCell>{t('slaReports.colTicket', { defaultValue: 'Ticket' })}</HeadCell>
              <HeadCell>{t('slaReports.colPriority', { defaultValue: 'Priority' })}</HeadCell>
              <HeadCell>{t('slaReports.colStatus', { defaultValue: 'Status' })}</HeadCell>
              {!agentFilter && (
                <HeadCell>{t('slaReports.colAgent', { defaultValue: 'Agent' })}</HeadCell>
              )}
              <HeadCell>
                {t('slaReports.colFirstResponse', { defaultValue: 'First response' })}
              </HeadCell>
              <HeadCell>{t('slaReports.colResolution', { defaultValue: 'Resolution' })}</HeadCell>
              <HeadCell className="text-end">
                {t('slaReports.colReplyTime', { defaultValue: '1st reply' })}
              </HeadCell>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {tickets.map((tk) => (
              <tr key={tk.id} className="transition-colors duration-fast hover:bg-secondary/40">
                <td
                  className="max-w-[16rem] truncate px-3 py-2.5 font-medium text-foreground"
                  title={tk.subject}
                >
                  {tk.subject}
                </td>
                <td className="px-3 py-2.5">
                  <Pill tone={PRIORITY_TONE[tk.priority] ?? 'neutral'} size="sm">
                    {t(`priority.${tk.priority}`, { ns: 'common', defaultValue: tk.priority })}
                  </Pill>
                </td>
                <td className="px-3 py-2.5">
                  <Pill tone={STATUS_TONE[tk.status] ?? 'neutral'} size="sm">
                    {t(`status.${tk.status}`, { ns: 'common', defaultValue: tk.status })}
                  </Pill>
                </td>
                {!agentFilter && (
                  <td className="px-3 py-2.5 text-muted-foreground">{tk.agentName}</td>
                )}
                <td className="px-3 py-2.5">
                  <SlaPill cell={tk.firstResponse} />
                </td>
                <td className="px-3 py-2.5">
                  <SlaPill cell={tk.resolution} />
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {fmtMins(tk.responseMinutes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
