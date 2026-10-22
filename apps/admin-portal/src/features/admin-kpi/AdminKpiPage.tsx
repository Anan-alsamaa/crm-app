import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  HBarChart,
  Pill,
  Skeleton,
  Table,
  TablePager,
  TableSurface,
  Td,
  Th,
  Tr,
  TrendChart,
  formatDate,
  formatDateTime,
} from '@yiji/ui';
import { downloadCsv, formatDuration, toCsv } from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { businessDayWindow, defaultReportRange, useRememberedRange } from '../../lib/date-range.js';
import { StatPanel } from '../sla-reports/KpiTile.js';
import {
  useAiKpi,
  useChatsKpi,
  useCouponsKpi,
  useLateOrdersKpi,
  useNotificationsKpi,
  usePeopleKpi,
  useTicketsKpi,
  useYijiUsageKpi,
  RECENT_USAGE_LIMIT,
  type YijiUsageEventRow,
} from './api.js';
import { PAGE_GUTTER, PageTitle } from '../../components/shell/Page.js';

/**
 * REPORTS -> ADMIN KPI (owner, 2026-10-21).
 *
 * Every feature's figures for the chosen window, read-only, for the owner:
 * chats, tickets, coupons, late orders, people, notifications, AI - and the
 * CRM's calls to Yiji, split by WHICH ACCOUNT made them (the CRM's own, or
 * the owner's backup token), with every backup use and every failure listed.
 *
 * Same shell as the other reports: the filter bar with the remembered range
 * (yesterday -> today by default), calm StatPanels, one table that pages.
 * Each block loads on its own, so one unreadable collection costs one block.
 */

const NUM = new Intl.NumberFormat('en-US');
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const n = (v: number) => NUM.format(v);
const PAGE_SIZES = [10, 25, 50, 100] as const;

/** A block that may fail alone: its own error, its own retry. */
function Block({
  error,
  onRetry,
  children,
}: {
  error: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!error) return <>{children}</>;
  return (
    <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
      <ErrorState
        className="py-8"
        title={t('adminKpi.blockError', { defaultValue: 'This block could not be loaded.' })}
        retryLabel={t('adminKpi.retry', { defaultValue: 'Retry' })}
        onRetry={onRetry}
      />
    </div>
  );
}

export function AdminKpiPage() {
  const { t } = useTranslation();
  const { from, to, setFrom, setTo, reset } = useRememberedRange(
    'admin-kpi-range',
    defaultReportRange,
  );
  const w = useMemo(() => businessDayWindow(from, to), [from, to]);
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  const chats = useChatsKpi(w);
  const tickets = useTicketsKpi(w);
  const coupons = useCouponsKpi(w);
  const late = useLateOrdersKpi(w);
  const people = usePeopleKpi();
  const notes = useNotificationsKpi(w);
  const ai = useAiKpi(w);
  const yiji = useYijiUsageKpi(w);

  const recent = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (yiji.data?.recent ?? []).filter(
      (r) =>
        (!account || r.account === account) &&
        (!needle ||
          [r.operation, r.service, r.error ?? '', r.fallback_reason ?? '']
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }, [yiji.data, search, account]);
  const pageRows = recent.slice((page - 1) * pageSize, page * pageSize);

  const accountLabel = (a: string) =>
    a === 'backup'
      ? t('adminKpi.yiji.backup', { defaultValue: 'Backup token' })
      : t('adminKpi.yiji.crm', { defaultValue: 'CRM account' });
  const outcomeLabel = (o: string) =>
    o === 'ok'
      ? t('adminKpi.yiji.ok', { defaultValue: 'OK' })
      : o === 'refused'
        ? t('adminKpi.yiji.refused', { defaultValue: 'Refused' })
        : t('adminKpi.yiji.error', { defaultValue: 'Error' });

  const exportRecent = () =>
    downloadCsv(
      exportFileName('yiji-api-usage'),
      toCsv(
        ['When', 'Service', 'Operation', 'Account', 'Outcome', 'HTTP', 'ms', 'Why backup', 'Error'],
        recent.map((r: YijiUsageEventRow) => [
          r.date_created,
          r.service,
          r.operation,
          r.account,
          r.outcome,
          r.http_status ?? '',
          r.duration_ms ?? '',
          r.fallback_reason ?? '',
          r.error ?? '',
        ]),
      ),
    );

  const c = chats.data;
  const tk = tickets.data;
  const cp = coupons.data;
  const lo = late.data;
  const pp = people.data;
  const nt = notes.data;
  const aiS = ai.data;
  const y = yiji.data;

  const removal = (k: string) => n(cp?.removal[k] ?? 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The Dashboard's gutter and full width (owner, 2026-10-22): the old
          centred max-w-6xl column sat off-centre against the page. */}
      <div className={cn('flex-1 overflow-auto', PAGE_GUTTER)}>
        <div className="space-y-4 pb-8">
          <PageTitle title={t('nav.adminKpiGroup', { defaultValue: 'Admin KPI' })} />
          <ReportFilterBar
            searchLabel={t('adminKpi.search', { defaultValue: 'Yiji calls' })}
            searchPlaceholder={t('adminKpi.searchPlaceholder', {
              defaultValue: 'Operation, service or error',
            })}
            search={search}
            onSearch={(v) => {
              setSearch(v);
              setPage(1);
            }}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            selects={[
              {
                key: 'account',
                label: t('adminKpi.yiji.account', { defaultValue: 'Account' }),
                value: account,
                onChange: (v) => {
                  setAccount(v);
                  setPage(1);
                },
                options: [
                  { value: 'crm', label: accountLabel('crm') },
                  { value: 'backup', label: accountLabel('backup') },
                ],
              },
            ]}
            filtering={!!search || !!account}
            onClear={() => {
              setSearch('');
              setAccount('');
              setPage(1);
              reset();
            }}
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={exportRecent}
                disabled={recent.length === 0}
              >
                {t('adminKpi.export', { defaultValue: 'Export CSV' })}
              </Button>
            }
          />

          {/* ── Every feature, one panel each ───────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Block error={chats.isError} onRetry={() => void chats.refetch()}>
              <StatPanel
                id="admin-kpi-chats"
                title={t('adminKpi.chats.title', { defaultValue: 'Chats' })}
                note={t('adminKpi.chats.note', { defaultValue: 'Chats opened in this window.' })}
                loading={chats.isLoading}
                cells={[
                  {
                    label: t('adminKpi.chats.total', { defaultValue: 'Chats' }),
                    value: n(c?.total ?? 0),
                  },
                  {
                    label: t('adminKpi.chats.closed', { defaultValue: 'Closed' }),
                    value: n(c?.closed ?? 0),
                    tone: 'green',
                  },
                  {
                    label: t('adminKpi.chats.open', { defaultValue: 'Still open' }),
                    value: n(c?.open ?? 0),
                    tone: 'amber',
                  },
                  {
                    label: t('adminKpi.chats.avgFirst', { defaultValue: 'Avg first response' }),
                    value: formatDuration(c?.avgFirstResponseSec ?? null) ?? '—',
                  },
                ]}
              />
            </Block>

            <Block error={tickets.isError} onRetry={() => void tickets.refetch()}>
              <StatPanel
                id="admin-kpi-tickets"
                title={t('adminKpi.tickets.title', { defaultValue: 'Tickets' })}
                note={t('adminKpi.tickets.note', {
                  defaultValue: 'Tickets created in this window, by compensation.',
                })}
                loading={tickets.isLoading}
                cells={[
                  {
                    label: t('adminKpi.tickets.created', { defaultValue: 'Created' }),
                    value: n(tk?.created ?? 0),
                  },
                  {
                    label: t('adminKpi.tickets.compensated', { defaultValue: 'Compensated' }),
                    value: n(tk?.compensated ?? 0),
                    tone: 'green',
                  },
                  {
                    label: t('adminKpi.tickets.notCompensated', {
                      defaultValue: 'Not compensated',
                    }),
                    value: n(tk?.notCompensated ?? 0),
                    tone: 'amber',
                  },
                  {
                    label: t('adminKpi.tickets.solved', { defaultValue: 'Solved' }),
                    value: n(tk?.byStatus.solved ?? 0),
                  },
                ]}
              />
            </Block>

            <Block error={coupons.isError} onRetry={() => void coupons.refetch()}>
              <StatPanel
                id="admin-kpi-coupons"
                title={t('adminKpi.coupons.title', { defaultValue: 'Coupons' })}
                note={t('adminKpi.coupons.note', {
                  defaultValue: 'Requests raised in this window and what became of them.',
                })}
                loading={coupons.isLoading}
                cells={[
                  {
                    label: t('adminKpi.coupons.requested', { defaultValue: 'Requested' }),
                    value: n(cp?.requested ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.approved', { defaultValue: 'Approved' }),
                    value: n(cp?.approved ?? 0),
                    tone: 'green',
                  },
                  {
                    label: t('adminKpi.coupons.rejected', { defaultValue: 'Rejected' }),
                    value: n(cp?.rejected ?? 0),
                    tone: 'crimson',
                  },
                  {
                    label: t('adminKpi.coupons.pending', { defaultValue: 'Waiting' }),
                    value: n(cp?.pending ?? 0),
                    tone: 'amber',
                  },
                  {
                    label: t('adminKpi.coupons.pushed', { defaultValue: 'Pushed to Yiji' }),
                    value: n(cp?.pushed ?? 0),
                    tone: 'green',
                  },
                  {
                    label: t('adminKpi.coupons.pushFailures', { defaultValue: 'Push failures' }),
                    value: n(cp?.pushFailures ?? 0),
                    tone: 'crimson',
                  },
                  {
                    label: t('adminKpi.coupons.withheld', { defaultValue: 'Withheld' }),
                    value: n(cp?.withheld ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.removed', { defaultValue: 'Removed' }),
                    value: removal('removed'),
                  },
                  {
                    label: t('adminKpi.coupons.removalUsed', { defaultValue: 'Already used' }),
                    value: removal('used'),
                  },
                  {
                    label: t('adminKpi.coupons.removalNotOnYiji', { defaultValue: 'Not on Yiji' }),
                    value: removal('not_on_yiji'),
                  },
                  {
                    label: t('adminKpi.coupons.removalPending', {
                      defaultValue: 'Removal waiting',
                    }),
                    value: removal('pending'),
                    tone: 'amber',
                  },
                  {
                    label: t('adminKpi.coupons.removalFailed', { defaultValue: 'Removal failed' }),
                    value: removal('failed'),
                    tone: 'crimson',
                  },
                ]}
              />
            </Block>

            <div className="space-y-4">
              <Block error={late.isError} onRetry={() => void late.refetch()}>
                <StatPanel
                  id="admin-kpi-late"
                  title={t('adminKpi.late.title', { defaultValue: 'Late orders' })}
                  note={t('adminKpi.late.note', {
                    defaultValue: 'Decisions in this window; each order counted by its newest one.',
                  })}
                  loading={late.isLoading}
                  cells={[
                    {
                      label: t('adminKpi.late.orders', { defaultValue: 'Orders decided' }),
                      value: n(lo?.orders ?? 0),
                    },
                    {
                      label: t('adminKpi.late.commented', { defaultValue: 'Commented' }),
                      value: n(lo?.commented ?? 0),
                      tone: 'amber',
                    },
                    {
                      label: t('adminKpi.late.compensated', { defaultValue: 'Compensated' }),
                      value: n(lo?.compensated ?? 0),
                      tone: 'green',
                    },
                    {
                      label: t('adminKpi.late.decisions', { defaultValue: 'Decisions' }),
                      value: n(lo?.decisions ?? 0),
                    },
                  ]}
                />
              </Block>

              <Block error={people.isError} onRetry={() => void people.refetch()}>
                <StatPanel
                  id="admin-kpi-people"
                  title={t('adminKpi.people.title', { defaultValue: 'Users & roles' })}
                  note={t('adminKpi.people.note', {
                    defaultValue: 'Right now, not the window. Service accounts are left out.',
                  })}
                  loading={people.isLoading}
                  cells={[
                    {
                      label: t('adminKpi.people.active', { defaultValue: 'Active users' }),
                      value: n(pp?.active ?? 0),
                      tone: 'green',
                    },
                    {
                      label: t('adminKpi.people.suspended', { defaultValue: 'Not active' }),
                      value: n(pp?.suspended ?? 0),
                    },
                    {
                      label: t('adminKpi.people.roles', { defaultValue: 'Roles in use' }),
                      value: n(pp?.byRole.length ?? 0),
                    },
                    {
                      label: t('adminKpi.people.busyNow', { defaultValue: 'Busy right now' }),
                      value: n(pp?.busyNow ?? 0),
                      tone: 'amber',
                    },
                  ]}
                />
              </Block>
            </div>

            <Block error={notes.isError} onRetry={() => void notes.refetch()}>
              <StatPanel
                id="admin-kpi-notifications"
                title={t('adminKpi.notifications.title', { defaultValue: 'Notifications' })}
                note={t('adminKpi.notifications.note', {
                  defaultValue: 'In-app notifications sent in this window.',
                })}
                loading={notes.isLoading}
                cells={[
                  {
                    label: t('adminKpi.notifications.total', { defaultValue: 'Sent' }),
                    value: n(nt?.total ?? 0),
                  },
                  {
                    label: t('adminKpi.notifications.unread', { defaultValue: 'Still unread' }),
                    value: n(nt?.unread ?? 0),
                    tone: 'amber',
                  },
                  ...(nt?.byType ?? [])
                    .slice(0, 2)
                    .map((x) => ({ label: x.type, value: n(x.count) })),
                ]}
              />
            </Block>

            <Block error={ai.isError} onRetry={() => void ai.refetch()}>
              <StatPanel
                id="admin-kpi-ai"
                title={t('adminKpi.ai.title', { defaultValue: 'AI calls' })}
                note={t('adminKpi.ai.note', {
                  defaultValue: 'Every model call; cost at the paid list price.',
                })}
                loading={ai.isLoading}
                cells={[
                  {
                    label: t('adminKpi.ai.calls', { defaultValue: 'Calls' }),
                    value: n(aiS?.calls ?? 0),
                  },
                  {
                    label: t('adminKpi.ai.errors', { defaultValue: 'Errors' }),
                    value: n(aiS?.errors ?? 0),
                    tone: 'crimson',
                  },
                  {
                    label: t('adminKpi.ai.cost', { defaultValue: 'Est. cost' }),
                    value: USD.format(aiS?.costUsd ?? 0),
                  },
                  {
                    label: t('adminKpi.ai.latency', { defaultValue: 'Avg latency' }),
                    value: aiS?.avgLatencyMs != null ? `${n(aiS.avgLatencyMs)} ms` : '—',
                  },
                ]}
              />
            </Block>
          </div>

          {/* ── Yiji API usage: which account, for what, how it went ─────── */}
          <Block error={yiji.isError} onRetry={() => void yiji.refetch()}>
            <div className="space-y-4">
              <StatPanel
                id="admin-kpi-yiji"
                title={t('adminKpi.yiji.title', { defaultValue: 'Yiji API usage' })}
                note={t('adminKpi.yiji.note', {
                  defaultValue:
                    'Every call the CRM made to Yiji. The backup token is used only when the CRM account is refused.',
                })}
                loading={yiji.isLoading}
                aside={
                  y?.lastBackup ? (
                    <Pill tone="warning" size="sm" title={y.lastBackup.fallback_reason ?? ''}>
                      {t('adminKpi.yiji.lastBackup', {
                        defaultValue: 'Backup last used {{when}}',
                        when: formatDateTime(y.lastBackup.date_created),
                      })}
                    </Pill>
                  ) : y ? (
                    <Pill tone="success" size="sm">
                      {t('adminKpi.yiji.neverBackup', { defaultValue: 'Backup never used' })}
                    </Pill>
                  ) : null
                }
                cells={[
                  {
                    label: t('adminKpi.yiji.total', { defaultValue: 'Calls' }),
                    value: n(y?.totals.total ?? 0),
                  },
                  {
                    label: accountLabel('crm'),
                    value: n(y?.totals.crm ?? 0),
                    tone: 'green',
                  },
                  {
                    label: accountLabel('backup'),
                    value: n(y?.totals.backup ?? 0),
                    tone: (y?.totals.backup ?? 0) > 0 ? 'amber' : 'blue',
                    ring: y?.totals.backupPct ?? null,
                  },
                  {
                    label: t('adminKpi.yiji.failed', { defaultValue: 'Refused / errors' }),
                    value: `${n(y?.totals.refused ?? 0)} / ${n(y?.totals.error ?? 0)}`,
                    tone: 'crimson',
                  },
                ]}
              />

              {y?.lastBackup && (
                <p className="text-xs text-muted-foreground">
                  {t('adminKpi.yiji.lastBackupWhy', {
                    defaultValue: 'Last backup use: {{operation}} ({{service}}) - {{reason}}',
                    operation: y.lastBackup.operation,
                    service: y.lastBackup.service,
                    reason: y.lastBackup.fallback_reason ?? '—',
                  })}
                </p>
              )}

              {y && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="rounded-2xl bg-card p-[1.125rem] shadow-soft ring-1 ring-foreground/[0.06]">
                    <h3 className="mb-3 text-[0.9375rem] font-semibold tracking-tight">
                      {t('adminKpi.yiji.trend', { defaultValue: 'Calls per day (UTC)' })}
                    </h3>
                    {y.trend ? (
                      <TrendChart
                        points={y.trend.map((d) => ({
                          label: formatDate(d.day),
                          values: { crm: d.crm, backup: d.backup, failed: d.failed },
                        }))}
                        series={[
                          { key: 'crm', label: accountLabel('crm'), tone: 'primary' },
                          { key: 'backup', label: accountLabel('backup'), tone: 'warning' },
                          {
                            key: 'failed',
                            label: t('adminKpi.yiji.failedShort', { defaultValue: 'Failed' }),
                            tone: 'destructive',
                          },
                        ]}
                        height={120}
                        format={(v) => n(v)}
                        emptyLabel={t('adminKpi.yiji.noCalls', {
                          defaultValue: 'No Yiji calls in this window.',
                        })}
                      />
                    ) : (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        {t('adminKpi.yiji.trendUnavailable', {
                          defaultValue: 'The daily trend could not be loaded.',
                        })}
                      </p>
                    )}
                  </section>
                  <section className="rounded-2xl bg-card p-[1.125rem] shadow-soft ring-1 ring-foreground/[0.06]">
                    <h3 className="mb-3 text-[0.9375rem] font-semibold tracking-tight">
                      {t('adminKpi.yiji.byOperation', { defaultValue: 'By operation' })}
                    </h3>
                    <HBarChart
                      rows={y.operations.slice(0, 12).map((o) => ({
                        label: o.operation,
                        values: { crm: o.crm, backup: o.backup },
                        ...(o.refused + o.error > 0
                          ? {
                              note: t('adminKpi.yiji.opFailed', {
                                defaultValue: '{{count}} failed',
                                count: o.refused + o.error,
                              }),
                            }
                          : {}),
                      }))}
                      series={[
                        { key: 'crm', label: accountLabel('crm'), tone: 'primary' },
                        { key: 'backup', label: accountLabel('backup'), tone: 'warning' },
                      ]}
                      format={(v) => n(v)}
                      emptyLabel={t('adminKpi.yiji.noCalls', {
                        defaultValue: 'No Yiji calls in this window.',
                      })}
                    />
                  </section>
                </div>
              )}

              <section aria-labelledby="admin-kpi-yiji-recent" className="space-y-2">
                <h3
                  id="admin-kpi-yiji-recent"
                  className="text-[0.9375rem] font-semibold tracking-tight"
                >
                  {t('adminKpi.yiji.recent', {
                    defaultValue: 'Recent failures and backup uses (newest {{limit}})',
                    limit: RECENT_USAGE_LIMIT,
                  })}
                </h3>
                {yiji.isLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : recent.length === 0 ? (
                  <EmptyState
                    title={t('adminKpi.yiji.recentEmpty', {
                      defaultValue: 'No failures and no backup use in this window.',
                    })}
                  />
                ) : (
                  <>
                    <TableSurface>
                      <Table
                        aria-label={t('adminKpi.yiji.recentTable', {
                          defaultValue: 'Yiji failures and backup uses',
                        })}
                      >
                        <thead>
                          <tr>
                            <Th>{t('adminKpi.yiji.col.when', { defaultValue: 'When' })}</Th>
                            <Th>{t('adminKpi.yiji.col.service', { defaultValue: 'Service' })}</Th>
                            <Th>
                              {t('adminKpi.yiji.col.operation', { defaultValue: 'Operation' })}
                            </Th>
                            <Th>{t('adminKpi.yiji.account', { defaultValue: 'Account' })}</Th>
                            <Th>{t('adminKpi.yiji.col.outcome', { defaultValue: 'Outcome' })}</Th>
                            <Th className="text-end">HTTP</Th>
                            <Th>
                              {t('adminKpi.yiji.col.detail', { defaultValue: 'Why / error' })}
                            </Th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((r) => (
                            <Tr key={String(r.id)}>
                              <Td className="whitespace-nowrap tabular-nums">
                                {formatDateTime(r.date_created)}
                              </Td>
                              <Td>{r.service}</Td>
                              <Td className="font-mono text-xs">{r.operation}</Td>
                              <Td>
                                <Pill
                                  tone={r.account === 'backup' ? 'warning' : 'neutral'}
                                  size="sm"
                                >
                                  {accountLabel(r.account)}
                                </Pill>
                              </Td>
                              <Td>
                                <Pill
                                  tone={
                                    r.outcome === 'ok'
                                      ? 'success'
                                      : r.outcome === 'refused'
                                        ? 'warning'
                                        : 'destructive'
                                  }
                                  size="sm"
                                  dot
                                >
                                  {outcomeLabel(r.outcome)}
                                </Pill>
                              </Td>
                              <Td className="text-end tabular-nums">{r.http_status ?? '—'}</Td>
                              <Td className="max-w-[28rem] text-xs text-muted-foreground">
                                {[r.fallback_reason, r.error].filter(Boolean).join(' · ') || '—'}
                              </Td>
                            </Tr>
                          ))}
                        </tbody>
                      </Table>
                    </TableSurface>
                    <TablePager
                      page={page}
                      onPage={setPage}
                      pageSize={pageSize}
                      onPageSize={(s) => {
                        setPageSize(s);
                        setPage(1);
                      }}
                      total={recent.length}
                      pageSizes={PAGE_SIZES}
                      labels={{
                        rowsPerPage: String(
                          t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' }),
                        ),
                        previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
                        next: String(t('agentReports.next', { defaultValue: 'Next' })),
                      }}
                    />
                  </>
                )}
              </section>
            </div>
          </Block>
        </div>
      </div>
    </div>
  );
}
