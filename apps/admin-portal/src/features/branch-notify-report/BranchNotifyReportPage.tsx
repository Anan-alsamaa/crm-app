import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import {
  CheckCircleIcon,
  ClockIcon,
  EmptyState,
  ErrorState,
  IdentityCell,
  InfoIcon,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  Skeleton,
  StoreIcon,
  Table,
  TableSurface,
  Td,
  Th,
  TicketIcon,
  Tr,
  cn,
} from '@yiji/ui';
import { formatDuration } from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { directus } from '../../lib/directus.js';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { ViewSwitch } from '../../components/ViewSwitch.js';
import { businessDayWindow, defaultReportRange, useRememberedRange } from '../../lib/date-range.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { PAGE_GUTTER, PageTitle } from '../../components/shell/Page.js';
import { ExportCsvButton } from '../../components/ExportCsvButton.js';
import { useSenderNames } from '../store-notifications/api.js';
import {
  branchLabel,
  byBranch,
  bySender,
  byTicketType,
  kindOf,
  matches,
  riyadhTime,
  sendSeconds,
  totals,
  type NotifyRow,
} from './report.js';

/**
 * AGENT KPI -> BRANCH NOTIFICATIONS (owner, 26 Nov 2026: "a new subpage ...
 * branch notification", for WeCare Admin and whoever opens Agent KPI).
 *
 * Everything sent to a branch's SaraPOS printer in the window: the automatic
 * notification a ticket raises and the custom messages agents write without
 * one. Read-only. By branch, by sender, by ticket type, and every message
 * with its full trail and a CSV.
 */

type View = 'branches' | 'senders' | 'types' | 'all';
const VIEWS: View[] = ['branches', 'senders', 'types', 'all'];

function useBranchNotifications(from: string, to: string) {
  const { fromIso, toIso } = businessDayWindow(from, to);
  return useQuery({
    queryKey: ['branch-notify-report', fromIso, toIso],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'store_notifications' as never,
          {
            fields: [
              'id',
              'kind',
              'status',
              'complaint_type',
              'order_id',
              'description',
              'error',
              'attempts',
              'date_created',
              'sent_at',
              'sender_name',
              'sender_login',
              'user_created',
              { store: ['id', 'code', 'name'] },
            ],
            filter: { date_created: { _between: [fromIso, toIso] } },
            sort: ['-date_created'],
            limit: -1,
          } as never,
        ),
      )) as unknown as NotifyRow[],
  });
}

export function BranchNotifyReportPage() {
  const { t } = useTranslation();
  const { from, to, setFrom, setTo, reset } = useRememberedRange(
    'branch-notify-report-range',
    defaultReportRange,
  );
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view') as View | null;
  const view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : 'branches';
  const setView = (v: View) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        if (v === 'branches') out.delete('view');
        else out.set('view', v);
        return out;
      },
      { replace: true },
    );

  const q = useBranchNotifications(from, to);
  /* Custom messages sent before the name was kept on the message (26 Nov):
     their sender is looked up from the account, while it exists. */
  const senders = useSenderNames(
    (q.data ?? [])
      .filter((r) => kindOf(r) === 'custom' && !r.sender_name)
      .map((r) => r.user_created ?? ''),
  );
  const nameOf = useMemo(
    () => (id: string | null | undefined) => (id ? senders.data?.get(id) || null : null),
    [senders.data],
  );
  const senderLabel = (r: NotifyRow) => {
    const name = r.sender_name || nameOf(r.user_created) || '';
    return name && r.sender_login ? `${name} (${r.sender_login})` : name;
  };

  const rows = useMemo(
    () =>
      (q.data ?? []).filter(
        (r) =>
          (!kind || kindOf(r) === kind) &&
          (!status || r.status === status) &&
          matches(r, search, nameOf),
      ),
    [q.data, kind, status, search, nameOf],
  );
  const sum = useMemo(() => totals(rows), [rows]);
  const branches = useMemo(() => byBranch(rows), [rows]);
  const people = useMemo(() => bySender(rows, nameOf), [rows, nameOf]);
  const types = useMemo(() => byTicketType(rows), [rows]);

  const kindWord = (r: NotifyRow) =>
    kindOf(r) === 'custom'
      ? t('branchReport.custom', { defaultValue: 'Custom message' })
      : t('branchReport.ticket', { defaultValue: 'Ticket' });
  const statusWord = (s: NotifyRow['status']) =>
    s === 'sent'
      ? t('branchReport.statusSent', { defaultValue: 'Sent' })
      : s === 'failed'
        ? t('branchReport.statusFailed', { defaultValue: 'Failed' })
        : t('branchReport.statusQueued', { defaultValue: 'Waiting' });
  const statusTone = (s: NotifyRow['status']) =>
    s === 'sent' ? 'success' : s === 'failed' ? 'destructive' : 'neutral';

  const exportCsv = () =>
    downloadCsv(
      exportFileName('branch-notifications'),
      toCsv(
        [
          'Queued (Riyadh)',
          'Sent (Riyadh)',
          'Branch code',
          'Branch',
          'Type',
          'Ticket type',
          'Sender',
          'Employee ID',
          'Order',
          'Message',
          'Status',
          'Attempts',
          'SaraPOS error',
        ],
        rows.map((r) => [
          riyadhTime(r.date_created),
          riyadhTime(r.sent_at),
          r.store?.code ?? '',
          r.store?.name ?? '',
          kindOf(r) === 'custom' ? 'Custom message' : 'Ticket',
          kindOf(r) === 'ticket' ? (r.complaint_type ?? '') : '',
          r.sender_name || nameOf(r.user_created) || '',
          r.sender_login ?? '',
          r.order_id ?? '',
          r.description ?? '',
          r.status,
          r.attempts ?? 0,
          r.error ?? '',
        ]),
      ),
    );

  const filtering = !!search || !!kind || !!status;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className={cn('flex-1 overflow-auto', PAGE_GUTTER)}>
        <div className="space-y-4 pb-8">
          <PageTitle
            title={t('nav.branchNotifyReport', { defaultValue: 'Branch notifications' })}
          />
          <ReportFilterBar
            searchLabel={t('branchReport.search', { defaultValue: 'Search' })}
            searchPlaceholder={t('branchReport.searchPlaceholder', {
              defaultValue: 'Branch, sender, order or text',
            })}
            search={search}
            onSearch={setSearch}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            selects={[
              {
                key: 'kind',
                label: t('branchReport.kind', { defaultValue: 'Type' }),
                value: kind,
                onChange: setKind,
                options: [
                  { value: 'ticket', label: t('branchReport.ticket', { defaultValue: 'Ticket' }) },
                  {
                    value: 'custom',
                    label: t('branchReport.custom', { defaultValue: 'Custom message' }),
                  },
                ],
              },
              {
                key: 'status',
                label: t('branchReport.status', { defaultValue: 'Status' }),
                value: status,
                onChange: setStatus,
                options: [
                  {
                    value: 'sent',
                    label: t('branchReport.statusSent', { defaultValue: 'Sent' }),
                  },
                  {
                    value: 'failed',
                    label: t('branchReport.statusFailed', { defaultValue: 'Failed' }),
                  },
                  {
                    value: 'queued',
                    label: t('branchReport.statusQueued', { defaultValue: 'Waiting' }),
                  },
                ],
              },
            ]}
            filtering={filtering}
            onClear={() => {
              setSearch('');
              setKind('');
              setStatus('');
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

          <ReportKpiStrip className="xl:grid-cols-5">
            <ReportKpi
              tone="blue"
              label={t('branchReport.kpiTotal', { defaultValue: 'Sent to branches' })}
              value={String(sum.total)}
              icon={<StoreIcon size={18} />}
            />
            <ReportKpi
              tone="violet"
              label={t('branchReport.kpiSplit', { defaultValue: 'From tickets / custom' })}
              value={`${sum.ticket} / ${sum.custom}`}
              icon={<TicketIcon size={18} />}
            />
            <ReportKpi
              tone="green"
              label={t('branchReport.kpiSent', { defaultValue: 'Printed' })}
              value={String(sum.sent)}
              icon={<CheckCircleIcon size={18} />}
            />
            <ReportKpi
              tone="amber"
              label={t('branchReport.kpiProblems', { defaultValue: 'Failed / waiting' })}
              value={`${sum.failed} / ${sum.queued}`}
              icon={<InfoIcon size={18} />}
            />
            <ReportKpi
              tone="blue"
              label={t('branchReport.kpiAvg', { defaultValue: 'Average time to print' })}
              value={sum.avgSendSec === null ? '—' : (formatDuration(sum.avgSendSec) ?? '0s')}
              icon={<ClockIcon size={18} />}
            />
          </ReportKpiStrip>

          <ViewSwitch
            value={view}
            onChange={setView}
            label={t('branchReport.views', { defaultValue: 'Branch notification views' })}
            options={[
              {
                value: 'branches',
                label: t('branchReport.byBranch', { defaultValue: 'By branch' }),
                count: branches.length,
              },
              {
                value: 'senders',
                label: t('branchReport.bySender', { defaultValue: 'By sender' }),
                count: people.length,
              },
              {
                value: 'types',
                label: t('branchReport.byType', { defaultValue: 'By ticket type' }),
                count: types.length,
              },
              {
                value: 'all',
                label: t('branchReport.every', { defaultValue: 'Every message' }),
                count: rows.length,
              },
            ]}
          />

          {q.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : q.isError ? (
            <ErrorState
              title={t('branchReport.error', {
                defaultValue: 'Could not load branch notifications.',
              })}
              onRetry={() => void q.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('branchReport.empty', {
                defaultValue: 'Nothing was sent to a branch in this period.',
              })}
            />
          ) : view === 'branches' ? (
            <TableSurface>
              <Table aria-label={t('branchReport.byBranch', { defaultValue: 'By branch' })}>
                <thead>
                  <tr>
                    <Th>{t('branchReport.branch', { defaultValue: 'Branch' })}</Th>
                    <Th className="text-end">
                      {t('branchReport.fromTickets', { defaultValue: 'From tickets' })}
                    </Th>
                    <Th className="text-end">
                      {t('branchReport.customMessages', { defaultValue: 'Custom messages' })}
                    </Th>
                    <Th className="text-end">
                      {t('branchReport.failed', { defaultValue: 'Failed' })}
                    </Th>
                    <Th className="text-end">
                      {t('branchReport.total', { defaultValue: 'Total' })}
                    </Th>
                    <Th>{t('branchReport.last', { defaultValue: 'Last' })}</Th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b) => (
                    <Tr key={b.key}>
                      <Td className="font-medium">{b.branch}</Td>
                      <Td className="text-end tabular-nums">{b.ticket}</Td>
                      <Td className="text-end tabular-nums">{b.custom}</Td>
                      <Td
                        className={cn(
                          'text-end tabular-nums',
                          b.failed > 0 && 'font-semibold text-destructive',
                        )}
                      >
                        {b.failed}
                      </Td>
                      <Td className="text-end font-semibold tabular-nums">{b.total}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{riyadhTime(b.last)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableSurface>
          ) : view === 'senders' ? (
            people.length === 0 ? (
              <EmptyState
                title={t('branchReport.noCustom', {
                  defaultValue: 'No custom messages in this period.',
                })}
              />
            ) : (
              <TableSurface>
                <Table aria-label={t('branchReport.bySender', { defaultValue: 'By sender' })}>
                  <thead>
                    <tr>
                      <Th>{t('branchReport.sender', { defaultValue: 'Sender' })}</Th>
                      <Th className="text-end">
                        {t('branchReport.messages', { defaultValue: 'Messages' })}
                      </Th>
                      <Th className="text-end">
                        {t('branchReport.branches', { defaultValue: 'Branches' })}
                      </Th>
                      <Th className="text-end">
                        {t('branchReport.failed', { defaultValue: 'Failed' })}
                      </Th>
                      <Th>{t('branchReport.last', { defaultValue: 'Last' })}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <Tr key={p.key}>
                        <Td>
                          <IdentityCell name={p.name} sub={p.login ?? ''} colorKey={p.key} />
                        </Td>
                        <Td className="text-end tabular-nums">{p.messages}</Td>
                        <Td className="text-end tabular-nums">{p.branches}</Td>
                        <Td
                          className={cn(
                            'text-end tabular-nums',
                            p.failed > 0 && 'font-semibold text-destructive',
                          )}
                        >
                          {p.failed}
                        </Td>
                        <Td className="whitespace-nowrap tabular-nums">{riyadhTime(p.last)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableSurface>
            )
          ) : view === 'types' ? (
            types.length === 0 ? (
              <EmptyState
                title={t('branchReport.noTicketRows', {
                  defaultValue: 'No ticket notifications in this period.',
                })}
              />
            ) : (
              <TableSurface>
                <Table aria-label={t('branchReport.byType', { defaultValue: 'By ticket type' })}>
                  <thead>
                    <tr>
                      <Th>{t('branchReport.ticketType', { defaultValue: 'Ticket type' })}</Th>
                      <Th className="text-end">
                        {t('branchReport.notifications', { defaultValue: 'Notifications' })}
                      </Th>
                      <Th className="text-end">
                        {t('branchReport.branches', { defaultValue: 'Branches' })}
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((x) => (
                      <Tr key={x.type}>
                        <Td className="font-medium">{x.type}</Td>
                        <Td className="text-end tabular-nums">{x.count}</Td>
                        <Td className="text-end tabular-nums">{x.branches}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableSurface>
            )
          ) : (
            <TableSurface>
              <Table aria-label={t('branchReport.every', { defaultValue: 'Every message' })}>
                <thead>
                  <tr>
                    <Th>{t('branchReport.queued', { defaultValue: 'Queued' })}</Th>
                    <Th>{t('branchReport.branch', { defaultValue: 'Branch' })}</Th>
                    <Th>{t('branchReport.kind', { defaultValue: 'Type' })}</Th>
                    <Th>{t('branchReport.message', { defaultValue: 'What was sent' })}</Th>
                    <Th>{t('branchReport.status', { defaultValue: 'Status' })}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const secs = sendSeconds(r);
                    return (
                      <Tr key={r.id} className="align-top">
                        <Td className="whitespace-nowrap tabular-nums">
                          {riyadhTime(r.date_created)}
                        </Td>
                        <Td className="font-medium">{branchLabel(r)}</Td>
                        <Td>
                          <div className="space-y-1">
                            <Pill tone={kindOf(r) === 'custom' ? 'purple' : 'neutral'} size="sm">
                              {kindWord(r)}
                            </Pill>
                            <p className="text-xs text-muted-foreground">
                              {kindOf(r) === 'custom'
                                ? senderLabel(r) || '—'
                                : (r.complaint_type ?? '—')}
                            </p>
                          </div>
                        </Td>
                        <Td className="max-w-[28rem]">
                          {r.order_id && (
                            <p className="font-mono text-xs text-muted-foreground">#{r.order_id}</p>
                          )}
                          <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs">
                            {r.description ?? '—'}
                          </p>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Pill tone={statusTone(r.status)} size="sm">
                            {statusWord(r.status)}
                          </Pill>
                          {r.sent_at && (
                            <p className="mt-1 text-2xs tabular-nums text-muted-foreground">
                              {riyadhTime(r.sent_at)}
                              {secs !== null ? ` · ${formatDuration(secs) ?? '0s'}` : ''}
                            </p>
                          )}
                          {(r.attempts ?? 0) > 1 && (
                            <p className="text-2xs text-muted-foreground">
                              {t('storeNotify.attempts', {
                                defaultValue: '{{n}} attempts',
                                n: r.attempts,
                              })}
                            </p>
                          )}
                          {r.status !== 'sent' && r.error && (
                            <p className="mt-1 max-w-[14rem] whitespace-normal text-2xs text-destructive">
                              {r.error}
                            </p>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableSurface>
          )}
        </div>
      </div>
    </div>
  );
}
