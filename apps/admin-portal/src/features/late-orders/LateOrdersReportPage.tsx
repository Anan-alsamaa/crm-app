import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  EmptyState,
  ErrorState,
  Pill,
  ReportKpi,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@yiji/ui';
import { useRememberedRange } from '../../lib/date-range.js';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { agentLateStats, agentName, useLateOrderDecisions } from './api.js';

/**
 * Late orders - the agent measure.
 *
 * What agents DID with the orders that ran past the threshold: how many they
 * handled, how they classified them, and how they resolved them.
 *
 * Counts only, deliberately. There is no "compensation rate" and no league
 * table: the right number of coupons to give depends on what actually went
 * wrong, and a rate on a dashboard becomes a target that rewards either giving
 * money away or refusing to.
 */
export function LateOrdersReportPage() {
  const { t } = useTranslation();
  /*
   * The range was REMEMBERED but unchangeable — the page read it and rendered
   * no control, so it sat on its default month for ever. `ReportFilterBar` is
   * what every other report uses, and it already holds the rule this screen
   * needs: typing waits for Apply, a dropdown applies at once.
   */
  const { from, to, setFrom, setTo, reset } = useRememberedRange('late-orders-report-range');
  const unknown = t('lateOrdersReport.unknownAgent', { defaultValue: 'Unassigned' });
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [action, setAction] = useState('');

  // The whole day at each end: a date alone would drop everything decided
  // after midnight on the closing day.
  const q = useLateOrderDecisions(`${from}T00:00:00`, `${to}T23:59:59`);
  const all = useMemo(() => q.data ?? [], [q.data]);

  /*
   * Narrowing happens HERE, not upstream: the window is already fetched, so an
   * order-number search or a cause filter is instant and costs nothing.
   */
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((r) => {
      if (kind && r.kind !== kind) return false;
      if (action && r.action !== action) return false;
      if (!term) return true;
      return `${r.order_id ?? ''} ${r.brand_name ?? ''} ${r.restaurant_name ?? ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [all, search, kind, action]);
  const stats = useMemo(() => agentLateStats(rows, unknown), [rows, unknown]);

  const totals = useMemo(() => {
    const compensated = rows.filter((r) => r.action === 'compensated').length;
    const mins = rows
      .map((r) => r.minutes_elapsed)
      .filter((m): m is number => typeof m === 'number');
    return {
      handled: rows.length,
      compensated,
      ignored: rows.filter((r) => r.action === 'ignored').length,
      preparation: rows.filter((r) => r.kind === 'late_preparation').length,
      avgMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
    };
  }, [rows]);

  if (q.isError) {
    return (
      <div className="p-4">
        <ErrorState
          title={t('lateOrdersReport.errorTitle', { defaultValue: 'Could not load late orders' })}
          message={t('lateOrdersReport.errorBody', {
            defaultValue: 'The register did not answer. This is not the same as there being none.',
          })}
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    /* The tab strip's Outlet supplies NO padding, so this page owns it — and
       owns its own scroll, which is why `h-full overflow-auto` rather than a
       plain block: without it a long register scrolls the page and takes the
       tab strip off screen. */
    <div className="h-full space-y-4 overflow-auto p-4">
      <ReportFilterBar
        searchLabel={t('lateOrdersReport.filter.search', { defaultValue: 'Order or branch' })}
        searchPlaceholder={t('lateOrdersReport.filter.searchPlaceholder', {
          defaultValue: 'e.g. 1314302, Okashi, Narjis',
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
            label: t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' }),
            value: kind,
            onChange: setKind,
            options: [
              {
                value: 'late_delivery',
                label: t('lateOrders.kind.late_delivery', { defaultValue: 'Late delivery' }),
              },
              {
                value: 'late_preparation',
                label: t('lateOrders.kind.late_preparation', { defaultValue: 'Late preparation' }),
              },
            ],
          },
          {
            key: 'action',
            label: t('lateOrdersReport.col.decision', { defaultValue: 'Decision' }),
            value: action,
            onChange: setAction,
            options: [
              {
                value: 'compensated',
                label: t('lateOrdersReport.action.compensated', { defaultValue: 'Compensated' }),
              },
              {
                value: 'ignored',
                label: t('lateOrdersReport.action.ignored', { defaultValue: 'Ignored' }),
              },
            ],
          },
        ]}
        filtering={!!search || !!kind || !!action}
        onClear={() => {
          setSearch('');
          setKind('');
          setAction('');
          reset();
        }}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ReportKpi
          label={t('lateOrdersReport.handled', { defaultValue: 'Late orders handled' })}
          value={String(totals.handled)}
          tone="blue"
        />
        <ReportKpi
          label={t('lateOrdersReport.compensated', { defaultValue: 'Compensated' })}
          value={String(totals.compensated)}
          tone="green"
        />
        <ReportKpi
          label={t('lateOrdersReport.ignored', { defaultValue: 'Ignored' })}
          value={String(totals.ignored)}
          tone="amber"
        />
        <ReportKpi
          label={t('lateOrdersReport.avgMinutes', { defaultValue: 'Average when decided' })}
          value={
            totals.avgMinutes == null
              ? '-'
              : t('lateOrdersReport.minutes', {
                  count: totals.avgMinutes,
                  defaultValue: '{{count}} min',
                })
          }
          tone="violet"
          hint={t('lateOrdersReport.preparationShare', {
            count: totals.preparation,
            defaultValue: '{{count}} late in preparation',
          })}
        />
      </div>

      {rows.length === 0 ? (
        /*
          SAYS WHAT THIS REPORT COUNTS, which is not what the agent's queue
          shows.

          The old title read "No late orders in this window" — and an admin who
          had just seen hundreds of late orders in the agent portal reasonably
          read that as broken (owner, 2026-09-22). It is not: that screen lists
          YIJI'S ORDERS, this one lists DECISIONS AGENTS RECORDED. Zero
          decisions is the honest answer until somebody uses the queue, and the
          empty state now says so rather than implying the orders are missing.
        */
        <EmptyState
          title={t('lateOrdersReport.noneTitle', {
            defaultValue: 'No decisions recorded in this window',
          })}
          description={t('lateOrdersReport.noneBody', {
            defaultValue:
              'This report counts what agents did with late orders — compensated or ignored. The late orders themselves are in the agent portal; a row appears here once an agent acts on one.',
          })}
        />
      ) : (
        <>
          <Card className="p-0">
            <h3 className="px-4 pt-4 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('lateOrdersReport.byAgent', { defaultValue: 'By agent' })}
            </h3>
            <Table>
              <thead>
                <Tr>
                  <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                  <Th>{t('lateOrdersReport.col.handled', { defaultValue: 'Handled' })}</Th>
                  <Th>{t('lateOrdersReport.col.compensated', { defaultValue: 'Compensated' })}</Th>
                  <Th>{t('lateOrdersReport.col.ignored', { defaultValue: 'Ignored' })}</Th>
                  <Th>{t('lateOrdersReport.col.preparation', { defaultValue: 'Preparation' })}</Th>
                  <Th>{t('lateOrdersReport.col.delivery', { defaultValue: 'Delivery' })}</Th>
                  <Th>{t('lateOrdersReport.col.avg', { defaultValue: 'Avg. minutes' })}</Th>
                </Tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <Tr key={s.agent}>
                    <Td className="whitespace-nowrap font-medium">{s.agent}</Td>
                    <Td className="tabular-nums">{s.handled}</Td>
                    <Td className="tabular-nums">{s.compensated}</Td>
                    <Td className="tabular-nums">{s.ignored}</Td>
                    <Td className="tabular-nums">{s.latePreparation}</Td>
                    <Td className="tabular-nums">{s.lateDelivery}</Td>
                    <Td className="tabular-nums">{s.avgMinutes ?? '-'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="p-0">
            <h3 className="px-4 pt-4 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('lateOrdersReport.register', { defaultValue: 'Every decision' })}
            </h3>
            <Table>
              <thead>
                <Tr>
                  <Th>{t('lateOrdersReport.col.when', { defaultValue: 'When' })}</Th>
                  <Th>{t('lateOrdersReport.col.order', { defaultValue: 'Order' })}</Th>
                  <Th>{t('lateOrdersReport.col.brand', { defaultValue: 'Brand / branch' })}</Th>
                  <Th>{t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' })}</Th>
                  <Th>{t('lateOrdersReport.col.decision', { defaultValue: 'Decision' })}</Th>
                  <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                  <Th>{t('lateOrdersReport.col.reason', { defaultValue: 'Reason' })}</Th>
                </Tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {r.date_created ? new Date(r.date_created).toLocaleString() : '-'}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{r.order_id ?? '-'}</Td>
                    <Td className="max-w-[14rem] truncate">
                      {[r.brand_name, r.restaurant_name].filter(Boolean).join(' - ') || '-'}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {r.kind ? t(`lateOrders.kind.${r.kind}`, { defaultValue: r.kind }) : '-'}
                    </Td>
                    <Td>
                      <Pill tone={r.action === 'compensated' ? 'success' : 'neutral'} size="sm">
                        {r.action
                          ? t(`lateOrdersReport.action.${r.action}`, { defaultValue: r.action })
                          : '-'}
                      </Pill>
                    </Td>
                    <Td className="whitespace-nowrap">{agentName(r, unknown)}</Td>
                    <Td className="max-w-[22rem]">
                      <span className="line-clamp-2 block leading-snug" title={r.reason ?? ''}>
                        {r.reason ?? '-'}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
