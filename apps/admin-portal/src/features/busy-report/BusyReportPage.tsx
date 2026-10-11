import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Button,
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
  formatDateTime,
} from '@yiji/ui';
import { formatDuration } from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { lastMonth, useRememberedRange } from '../../lib/date-range.js';
import { busyReport } from '../../lib/job-producer.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { useUsers } from '../users/api.js';
import { summarize, toRows } from './busy.js';

/**
 * AGENT KPI → BUSY TIME (owner, 2026-10-11).
 *
 * Every time an agent pressed Busy (no new chats while signed in): how many
 * times, for how long in total, and each stretch with its start, end and
 * duration. Filter by one agent or all agents.
 */
export function BusyReportPage() {
  const { t } = useTranslation();
  const { from, to, setFrom, setTo, reset } = useRememberedRange('busy-report-range', lastMonth);
  const [agent, setAgent] = useState('');
  const [search, setSearch] = useState('');
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

  const q = useQuery({
    queryKey: ['busy-report', from, to, agent],
    queryFn: () => busyReport({ from, to, ...(agent ? { agentId: agent } : {}) }),
  });
  const rows = useMemo(() => {
    const all = toRows(q.data ?? []);
    const needle = search.trim().toLowerCase();
    return needle ? all.filter((r) => nameOf(r.agent).toLowerCase().includes(needle)) : all;
  }, [q.data, search, nameOf]);
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
        ['Agent', 'Started', 'Ended', 'Duration (minutes)'],
        rows.map((r) => [
          nameOf(r.agent),
          r.started_at,
          r.ended_at ?? 'ongoing',
          Math.round(r.durationSec / 60),
        ]),
      ),
    );

  return (
    <div className="flex flex-col gap-4">
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
        ]}
        filtering={!!agent || !!search}
        onClear={() => {
          setAgent('');
          setSearch('');
          reset();
        }}
        actions={
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            {t('busyReport.export', { defaultValue: 'Export CSV' })}
          </Button>
        }
      />

      <ReportKpiStrip>
        <ReportKpi
          tone="blue"
          label={t('busyReport.kpiTimes', { defaultValue: 'Times Busy was used' })}
          value={String(rows.length)}
        />
        <ReportKpi
          tone="amber"
          label={t('busyReport.kpiTotal', { defaultValue: 'Total busy time' })}
          value={formatDuration(totalSec) ?? '0s'}
        />
        <ReportKpi
          tone="violet"
          label={t('busyReport.kpiAgents', { defaultValue: 'Agents' })}
          value={String(perAgent.length)}
        />
      </ReportKpiStrip>

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
      ) : (
        <>
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
                    <Td className="font-medium">{nameOf(a.agent)}</Td>
                    <Td className="text-end tabular-nums">{a.times}</Td>
                    <Td className="text-end tabular-nums">{formatDuration(a.totalSec) ?? '0s'}</Td>
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

          <TableSurface maxHeight="30rem">
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
                    <Td className="font-medium">{nameOf(r.agent)}</Td>
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
        </>
      )}
    </div>
  );
}
