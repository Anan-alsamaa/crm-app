import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
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
  formatDate,
  formatDateTime,
} from '@yiji/ui';
import { businessDay } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { exportFileName } from '@yiji/shared-config';
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
  /** One business day, as `YYYY-MM-DD`. Empty means every day in the window. */
  const [bizDay, setBizDay] = useState('');
  /*
   * WHICH AGENT (owner, 2026-09-29). Empty means every agent, which is how the
   * report opens — a supervisor reads the whole team first and narrows after.
   */
  const [agent, setAgent] = useState('');
  /*
   * TWO SUB-PAGES, decisions first (owner, 2026-09-28).
   *
   * They answer different questions — what was decided, and how each agent is
   * doing — and stacking both made a long register push the agent table off the
   * screen entirely. `Order decisions` opens by default: it is the record of
   * what actually happened, and the agent table is a summary OF it.
   *
   * An in-page tab rather than a nested route, deliberately: five filters and
   * one query feed both views, so a route change would remount the filter bar
   * and refetch for a switch that costs nothing.
   */
  const [tab, setTab] = useState<'decisions' | 'agents'>('decisions');

  /*
   * The window is widened at BOTH ends to cover whole BUSINESS days.
   *
   * A business day runs 08:00 to 04:00 the next morning, so a calendar window
   * cuts the nights at each edge: everything decided between midnight and
   * 04:00 on the closing day's night fell outside `to T23:59:59` and vanished
   * from a report that claimed to cover that day. The opening edge has the
   * mirror problem — 00:00-08:00 on `from` belongs to the PREVIOUS business
   * day and should not be counted as this window's.
   *
   * So: fetch from `from T00:00` (the extra early hours are filtered out by
   * business day below when one is picked) through `to +1 day T04:00`, which
   * is exactly where the closing night ends.
   */
  const toNight = new Date(`${to}T00:00:00Z`);
  toNight.setUTCDate(toNight.getUTCDate() + 1);
  const q = useLateOrderDecisions(
    `${from}T00:00:00`,
    `${toNight.toISOString().slice(0, 10)}T04:00:00`,
  );
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
      // The BUSINESS day (08:00-04:00), not the calendar date — a decision at
      // 01:00 belongs to the night before, and filtering by date would put it
      // on the wrong day.
      if (bizDay && businessDay(r.date_created) !== bizDay) return false;
      /* Matched on the RESOLVED name, which is what the column shows and what
         the picker offers — comparing raw ids would mean the filter and the
         table disagreed about who "Unassigned" is. */
      if (agent && agentName(r, unknown) !== agent) return false;
      if (!term) return true;
      return `${r.order_id ?? ''} ${r.brand_name ?? ''} ${r.restaurant_name ?? ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [all, search, kind, action, bizDay, agent, unknown]);
  /*
   * The business days actually PRESENT in the fetched window, newest first.
   *
   * Derived from the rows rather than enumerated from the date range: a range
   * of a month would otherwise offer thirty options, twenty-eight of which
   * return nothing. A picker whose entries mostly lead to an empty table is a
   * picker that has stopped helping.
   */
  /*
   * The agents actually PRESENT in the window, alphabetically.
   *
   * Derived from the rows rather than read from the user list, for the same
   * reason the business days are: a picker listing every agent who has ever
   * worked here, on a report covering last week, is mostly entries that lead to
   * an empty table.
   */
  const agents = useMemo(() => {
    const seen = new Set<string>();
    for (const r of all) seen.add(agentName(r, unknown));
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [all, unknown]);

  const businessDays = useMemo(() => {
    const seen = new Set<string>();
    for (const r of all) {
      const d = businessDay(r.date_created);
      if (d) seen.add(d);
    }
    return [...seen].sort().reverse();
  }, [all]);

  const stats = useMemo(() => agentLateStats(rows, unknown), [rows, unknown]);

  /*
   * EXPORT, ONE BUTTON PER TABLE (owner, 2026-09-28).
   *
   * Two tables answer two questions — who handled what, and every individual
   * decision — so one combined file would be two different shapes stacked in
   * one CSV, which is not openable as a spreadsheet. Each exports itself.
   *
   * WECARE ADMIN, WECARE SUPERVISOR AND THE OWNER (owner, 2026-09-28).
   *
   * NOT gated on `export_data`: I checked the live roles, and EVERY app role
   * holds that privilege — WeCare Agent, Viewer and all five Area Managers
   * included — so keying on it would have shown the button to everyone and
   * silently ignored the instruction. It is the kind of gate that looks right
   * in the diff and does nothing.
   *
   * So it names the two roles, plus `isOwner` (Directus `admin_access`), which
   * is how Administrator is identified everywhere in this portal — the owner is
   * never a role name.
   *
   * Hiding is not securing, and it is not pretending to be: the rows are
   * already on screen for anyone who can open this page. This decides who is
   * OFFERED the file, which is what was asked for.
   */
  const { user, isOwner } = useAuth();
  const EXPORT_ROLES = ['WeCare Admin', 'WeCare Supervisor'];
  const canExport = isOwner || EXPORT_ROLES.includes(user?.role?.name ?? '');

  const exportByAgent = () => {
    const header = [
      t('lateOrdersReport.col.agent', { defaultValue: 'Agent' }),
      t('lateOrdersReport.col.handled', { defaultValue: 'Handled' }),
      t('lateOrdersReport.col.compensated', { defaultValue: 'Compensated' }),
      t('lateOrdersReport.col.ignored', { defaultValue: 'Ignored' }),
      t('lateOrdersReport.col.preparation', { defaultValue: 'Preparation' }),
      t('lateOrdersReport.col.delivery', { defaultValue: 'Delivery' }),
      t('lateOrdersReport.col.avg', { defaultValue: 'Avg. minutes' }),
    ];
    const body = stats.map((r) => [
      r.agent,
      r.handled,
      r.compensated,
      r.ignored,
      r.latePreparation,
      r.lateDelivery,
      // Blank, not 0: no measurable orders is not an average of zero minutes.
      r.avgMinutes ?? '',
    ]);
    downloadCsv(exportFileName('Late orders by agent', {}), toCsv(header, body));
  };

  const exportDecisions = () => {
    const header = [
      t('lateOrdersReport.col.when', { defaultValue: 'When' }),
      t('lateOrdersReport.col.businessDay', { defaultValue: 'Business day' }),
      t('lateOrdersReport.col.order', { defaultValue: 'Order' }),
      t('lateOrdersReport.col.brand', { defaultValue: 'Brand / branch' }),
      t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' }),
      t('lateOrdersReport.col.decision', { defaultValue: 'Decision' }),
      t('lateOrdersReport.col.agent', { defaultValue: 'Agent' }),
      t('lateOrdersReport.col.reason', { defaultValue: 'Reason' }),
      t('lateOrdersReport.col.action', { defaultValue: 'Action taken' }),
    ];
    const body = rows.map((r) => {
      const day = businessDay(r.date_created);
      return [
        // ISO, not the dd/mm/yyyy on screen: a spreadsheet sorts and filters an
        // ISO stamp correctly and re-formats it for the reader either way.
        r.date_created ?? '',
        day ?? '',
        r.order_id ?? '',
        [r.brand_name, r.restaurant_name].filter(Boolean).join(' - '),
        r.kind ? t(`lateOrders.kind.${r.kind}`, { defaultValue: r.kind }) : '',
        r.action ? t(`lateOrdersReport.action.${r.action}`, { defaultValue: r.action }) : '',
        agentName(r, unknown),
        // The WHOLE text, not the two clamped lines the table shows: the export
        // exists precisely to get at what does not fit on screen.
        r.reason ?? '',
        r.action_taken ?? '',
      ];
    });
    downloadCsv(exportFileName('Late order decisions', {}), toCsv(header, body));
  };

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
    /* `space-y-6` and `p-5`: the two tables sat almost touching, so on a long
       register it read as one continuous grid with a stray heading in the
       middle (owner, 2026-09-28). */
    <div className="h-full space-y-6 overflow-auto p-5">
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
            /*
             * BUSINESS DAY, 08:00 to 04:00 — the day operations actually work
             * to. Offered only for the days present in the fetched window, so
             * every option returns rows.
             */
            key: 'businessDay',
            label: t('lateOrdersReport.col.businessDay', { defaultValue: 'Business day' }),
            value: bizDay,
            onChange: setBizDay,
            options: businessDays.map((d) => ({ value: d, label: formatDate(d) })),
          },
          {
            key: 'agent',
            label: t('lateOrdersReport.col.agent', { defaultValue: 'Agent' }),
            value: agent,
            onChange: setAgent,
            options: agents.map((a) => ({ value: a, label: a })),
          },
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
        /* The agent belongs in BOTH: omitted from `filtering` the Clear button
           would not appear for an agent-only filter, and omitted from
           `onClear` it would survive a clear that claims to remove everything. */
        filtering={!!search || !!kind || !!action || !!bizDay || !!agent}
        onClear={() => {
          setSearch('');
          setKind('');
          setAction('');
          setBizDay('');
          setAgent('');
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
          {/*
            THE TWO SUB-PAGES. Pills, matching the report tab strip one level
            up, so the second level of navigation looks like the first rather
            than introducing a third idea of what a tab is.
          */}
          <nav
            aria-label={t('lateOrdersReport.views', { defaultValue: 'View' })}
            className="flex items-center gap-1"
          >
            {(
              [
                ['decisions', t('lateOrdersReport.register', { defaultValue: 'Order decisions' })],
                ['agents', t('lateOrdersReport.byAgent', { defaultValue: 'Agent statistics' })],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? 'shrink-0 rounded-full bg-primary/15 px-3.5 py-1.5 text-sm font-semibold text-primary ring-1 ring-inset ring-primary/25'
                    : 'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground'
                }
              >
                {label}
              </button>
            ))}
          </nav>

          {/*
            A HEADER ROW, not a bare heading (owner, 2026-09-28: "positioned
            properly with enough space and padding"). The title and its own
            export sit on one line with real padding, and the table starts
            below it rather than immediately under the words.
          */}
          {/* RENDERED, not hidden: a `hidden` card still builds every row, and
              the register runs to hundreds. Only the open sub-page pays. */}
          {tab === 'agents' && (
            <Card className="p-0">
              <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-5">
                <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('lateOrdersReport.byAgent', { defaultValue: 'Agent statistics' })}
                </h3>
                {canExport && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="ms-auto"
                    onClick={exportByAgent}
                    disabled={stats.length === 0}
                  >
                    {t('lateOrdersReport.exportCsv', { defaultValue: 'Export to CSV' })}
                  </Button>
                )}
              </div>
              {/*
              THE TABLE SCROLLS, NOT THE PAGE (owner, 2026-09-29).
              
              On a laptop these columns run past the viewport, and the page
              itself was the thing that moved — so reaching the last column
              meant dragging the WHOLE report sideways, filters and headings
              included, and the scrollbar sat at the very foot of the window
              rather than under the table it belonged to.
              
              Same treatment the other reports already use: the card owns a
              horizontal scroller with a VISIBLE thumb. The app's global
              scrollbar is deliberately faint, which is right for a page and
              wrong for the one control that reaches half a report's columns.
            */}
              <div className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] overflow-x-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                      <Th>{t('lateOrdersReport.col.handled', { defaultValue: 'Handled' })}</Th>
                      <Th>
                        {t('lateOrdersReport.col.compensated', { defaultValue: 'Compensated' })}
                      </Th>
                      <Th>{t('lateOrdersReport.col.ignored', { defaultValue: 'Ignored' })}</Th>
                      <Th>
                        {t('lateOrdersReport.col.preparation', { defaultValue: 'Preparation' })}
                      </Th>
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
              </div>
            </Card>
          )}

          {tab === 'decisions' && (
            <Card className="p-0">
              <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-5">
                <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('lateOrdersReport.register', { defaultValue: 'Order decisions' })}
                </h3>
                {canExport && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="ms-auto"
                    onClick={exportDecisions}
                    disabled={rows.length === 0}
                  >
                    {t('lateOrdersReport.exportCsv', { defaultValue: 'Export to CSV' })}
                  </Button>
                )}
              </div>
              {/*
              THE TABLE SCROLLS, NOT THE PAGE (owner, 2026-09-29).
              
              On a laptop these columns run past the viewport, and the page
              itself was the thing that moved — so reaching the last column
              meant dragging the WHOLE report sideways, filters and headings
              included, and the scrollbar sat at the very foot of the window
              rather than under the table it belonged to.
              
              Same treatment the other reports already use: the card owns a
              horizontal scroller with a VISIBLE thumb. The app's global
              scrollbar is deliberately faint, which is right for a page and
              wrong for the one control that reaches half a report's columns.
            */}
              <div className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] overflow-x-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>{t('lateOrdersReport.col.when', { defaultValue: 'When' })}</Th>
                      <Th>
                        {t('lateOrdersReport.col.businessDay', { defaultValue: 'Business day' })}
                      </Th>
                      <Th>{t('lateOrdersReport.col.order', { defaultValue: 'Order' })}</Th>
                      <Th>{t('lateOrdersReport.col.brand', { defaultValue: 'Brand / branch' })}</Th>
                      <Th>
                        {t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' })}
                      </Th>
                      <Th>{t('lateOrdersReport.col.decision', { defaultValue: 'Decision' })}</Th>
                      <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                      <Th>{t('lateOrdersReport.col.reason', { defaultValue: 'Reason' })}</Th>
                      <Th>{t('lateOrdersReport.col.action', { defaultValue: 'Action taken' })}</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Tr key={r.id}>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          {r.date_created ? formatDateTime(r.date_created) : '-'}
                        </Td>
                        {/*
                      THE BUSINESS DAY, 10:00 to 04:00, named after the day it
                      started. Trading runs past midnight, so the calendar date
                      splits one night's work across two rows: 23:50 and 00:10
                      are the same shift and belong on the same line.
                      Derived, never stored — the rule is one function and the
                      report must not hold a second, older copy of it.
                    */}
                        <Td className="whitespace-nowrap tabular-nums">
                          {(() => {
                            const day = businessDay(r.date_created);
                            return day ? formatDate(day) : '-';
                          })()}
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
                        {/* What the agent DID about it, beside why it happened.
                        `title` carries the full text, since the cell clamps. */}
                        <Td className="max-w-[22rem]">
                          <span
                            className="line-clamp-2 block leading-snug"
                            title={r.action_taken ?? ''}
                          >
                            {r.action_taken ?? '-'}
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
