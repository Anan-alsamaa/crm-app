import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  IdentityCell,
  EmptyState,
  ErrorState,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  Skeleton,
  Table,
  TableSurface,
  Td,
  Th,
  Tr,
  UsersIcon,
  ZapIcon,
  formatDateTime,
  cn,
} from '@yiji/ui';
import { formatDuration } from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { ViewSwitch } from '../../components/ViewSwitch.js';
import { defaultReportRange, useRememberedRange } from '../../lib/date-range.js';
import { busyReport } from '../../lib/job-producer.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { useUsers } from '../users/api.js';
import { summarize, toRows } from './busy.js';
import { PAGE_GUTTER, PageTitle } from '../../components/shell/Page.js';
import { ExportCsvButton } from '../../components/ExportCsvButton.js';

/**
 * AGENT KPI → BUSY TIME (owner, 2026-10-11).
 *
 * Every time an agent pressed Busy (no new chats while signed in): how many
 * times, for how long in total, and each stretch with its start, end and
 * duration. Filter by one agent or all agents.
 *
 * TWO SUB-PAGES (owner, 2026-10-13): "By agent" (the totals) and "Every
 * period" (each stretch), one table each, in the same page shell as the other
 * reports - padding on the content, the page owns the scroll.
 */

type View = 'agents' | 'periods';

export function BusyReportPage() {
  const { t } = useTranslation();
  const { from, to, setFrom, setTo, reset } = useRememberedRange(
    'busy-report-range',
    defaultReportRange,
  );
  const [agent, setAgent] = useState('');
  /* By ROLE too (owner, 2026-10-13): the Administrator, WeCare Supervisor,
     WeCare Admin... - each agent's CURRENT role. */
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'periods' ? 'periods' : 'agents';
  const setView = (v: View) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        if (v === 'agents') out.delete('view');
        else out.set('view', v);
        return out;
      },
      { replace: true },
    );
  const users = useUsers();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users.data ?? []) {
      const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
      m.set(u.id, n || u.login_name || u.email || u.id);
    }
    return (id: string | null) =>
      id ? (m.get(id) ?? id) : t('busyReport.unknown', { defaultValue: 'Unknown agent' });
  }, [users.data, t]);
  const roleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users.data ?? []) if (u.role?.name) m.set(u.id, u.role.name);
    return (id: string | null) => (id ? (m.get(id) ?? '') : '');
  }, [users.data]);
  const roleOptions = useMemo(
    () =>
      [...new Set((users.data ?? []).map((u) => u.role?.name).filter((n): n is string => !!n))]
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ value: n, label: n })),
    [users.data],
  );

  const q = useQuery({
    queryKey: ['busy-report', from, to, agent],
    queryFn: () => busyReport({ from, to, ...(agent ? { agentId: agent } : {}) }),
  });
  const rows = useMemo(() => {
    const all = toRows(q.data ?? []).filter((r) => !role || roleOf(r.agent) === role);
    const needle = search.trim().toLowerCase();
    return needle ? all.filter((r) => nameOf(r.agent).toLowerCase().includes(needle)) : all;
  }, [q.data, search, nameOf, role, roleOf]);
  const perAgent = useMemo(() => summarize(rows), [rows]);
  const totalSec = rows.reduce((s, r) => s + r.durationSec, 0);

  const agentOptions = useMemo(
    () =>
      (users.data ?? [])
        .filter((u) => u.status === 'active')
        .map((u) => ({ value: u.id, label: nameOf(u.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [users.data, nameOf],
  );

  const exportCsv = () =>
    downloadCsv(
      exportFileName('busy-time'),
      toCsv(
        ['Agent', 'Role', 'Started', 'Ended', 'Duration (minutes)'],
        rows.map((r) => [
          nameOf(r.agent),
          roleOf(r.agent),
          r.started_at,
          r.ended_at ?? 'ongoing',
          Math.round(r.durationSec / 60),
        ]),
      ),
    );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The Dashboard's gutter and full width (owner, 2026-10-22): the old
          centred max-w-6xl column sat off-centre under the tab strip. */}
      <div className={cn('flex-1 overflow-auto', PAGE_GUTTER)}>
        <div className="space-y-4 pb-8">
          <PageTitle title={t('nav.busyReport', { defaultValue: 'Busy time' })} />
          <ReportFilterBar
            searchLabel={t('busyReport.search', { defaultValue: 'Agent' })}
            searchPlaceholder={t('busyReport.searchPlaceholder', { defaultValue: 'Agent name' })}
            search={search}
            onSearch={setSearch}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            selects={[
              {
                key: 'agent',
                label: t('busyReport.agent', { defaultValue: 'Agent' }),
                value: agent,
                onChange: setAgent,
                options: agentOptions,
              },
              {
                key: 'role',
                label: t('busyReport.role', { defaultValue: 'Role' }),
                value: role,
                onChange: setRole,
                options: roleOptions,
              },
            ]}
            filtering={!!agent || !!search || !!role}
            onClear={() => {
              setAgent('');
              setRole('');
              setSearch('');
              reset();
            }}
            actions={
              <ExportCsvButton
                onExport={exportCsv}
                count={rows.length}
                label={t('agentReports.exportCsvCount', {
                  count: rows.length,
                  defaultValue: 'Export CSV ({{count}})',
                })}
              />
            }
          />

          <ReportKpiStrip className="xl:grid-cols-3">
            <ReportKpi
              tone="blue"
              label={t('busyReport.kpiTimes', { defaultValue: 'Times Busy was used' })}
              value={String(rows.length)}
              icon={<ZapIcon size={18} />}
            />
            <ReportKpi
              tone="amber"
              label={t('busyReport.kpiTotal', { defaultValue: 'Total busy time' })}
              value={formatDuration(totalSec) ?? '0s'}
              icon={<ClockIcon size={18} />}
            />
            <ReportKpi
              tone="violet"
              label={t('busyReport.kpiAgents', { defaultValue: 'Agents' })}
              value={String(perAgent.length)}
              icon={<UsersIcon size={18} />}
            />
          </ReportKpiStrip>

          <ViewSwitch
            value={view}
            onChange={setView}
            label={t('busyReport.views', { defaultValue: 'Busy time views' })}
            options={[
              {
                value: 'agents',
                label: t('busyReport.byAgentTab', { defaultValue: 'By agent' }),
                count: perAgent.length,
              },
              {
                value: 'periods',
                label: t('busyReport.periodsTab', { defaultValue: 'Every period' }),
                count: rows.length,
              },
            ]}
          />

          {q.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : q.isError ? (
            <ErrorState
              title={t('busyReport.error', { defaultValue: 'Could not load busy time.' })}
              onRetry={() => void q.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('busyReport.empty', { defaultValue: 'Nobody used Busy in this period.' })}
            />
          ) : view === 'agents' ? (
            <TableSurface>
              <Table aria-label={t('busyReport.byAgent', { defaultValue: 'Busy time by agent' })}>
                <thead>
                  <tr>
                    <Th>{t('busyReport.agent', { defaultValue: 'Agent' })}</Th>
                    <Th className="text-end">{t('busyReport.times', { defaultValue: 'Times' })}</Th>
                    <Th className="text-end">
                      {t('busyReport.total', { defaultValue: 'Total time' })}
                    </Th>
                    <Th className="text-end">
                      {t('busyReport.longest', { defaultValue: 'Longest' })}
                    </Th>
                    <Th>{t('busyReport.last', { defaultValue: 'Last used' })}</Th>
                  </tr>
                </thead>
                <tbody>
                  {perAgent.map((a) => (
                    <Tr key={a.agent ?? 'unknown'}>
                      <Td>
                        <IdentityCell
                          name={nameOf(a.agent)}
                          sub={roleOf(a.agent)}
                          colorKey={a.agent ?? ''}
                        />
                      </Td>
                      <Td className="text-end tabular-nums">{a.times}</Td>
                      <Td className="text-end tabular-nums">
                        {formatDuration(a.totalSec) ?? '0s'}
                      </Td>
                      <Td className="text-end tabular-nums">
                        {formatDuration(a.longestSec) ?? '0s'}
                      </Td>
                      <Td className="tabular-nums">
                        {a.lastStartedAt ? formatDateTime(a.lastStartedAt) : '—'}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableSurface>
          ) : (
            <TableSurface>
              <Table aria-label={t('busyReport.periods', { defaultValue: 'Every busy period' })}>
                <thead>
                  <tr>
                    <Th>{t('busyReport.agent', { defaultValue: 'Agent' })}</Th>
                    <Th>{t('busyReport.started', { defaultValue: 'Started' })}</Th>
                    <Th>{t('busyReport.ended', { defaultValue: 'Ended' })}</Th>
                    <Th className="text-end">
                      {t('busyReport.duration', { defaultValue: 'Duration' })}
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <IdentityCell
                          name={nameOf(r.agent)}
                          sub={roleOf(r.agent)}
                          colorKey={r.agent ?? ''}
                        />
                      </Td>
                      <Td className="tabular-nums">{formatDateTime(r.started_at)}</Td>
                      <Td className="tabular-nums">
                        {r.ended_at ? (
                          formatDateTime(r.ended_at)
                        ) : (
                          <Pill tone="warning" size="sm">
                            {t('busyReport.ongoing', { defaultValue: 'Still busy' })}
                          </Pill>
                        )}
                      </Td>
                      <Td className="text-end tabular-nums">
                        {formatDuration(r.durationSec) ?? '0s'}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableSurface>
          )}
        </div>
      </div>
    </div>
  );
}
