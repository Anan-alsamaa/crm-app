import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Pill,
  ReportKpi,
  Skeleton,
  TablePager,
  pageCountOf,
  Table,
  TableSurface,
  Td,
  Th,
  Tr,
  Modal,
  formatDate,
  formatDateTime,
} from '@yiji/ui';
import { businessDay, orderEventTimes, type LateOrderState } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { exportFileName } from '@yiji/shared-config';
import { businessDayWindow, useRememberedRange } from '../../lib/date-range.js';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { OrderSnapshotPanel } from './OrderSnapshotPanel.js';
import {
  agentLateStats,
  agentName,
  mergeLateOrders,
  useLateOrderDecisions,
  useLateOrderEventTimes,
  useLateOrderQueue,
  useLateOrderThreshold,
} from './api.js';

/**
 * Rows per page. The same ladder the ticket reports use, 1000 included — a
 * register over a real date range runs to thousands of rows, and the owner asked
 * for the breakdown report's treatment (2026-09-29).
 */
const REGISTER_PAGE_SIZES = [10, 25, 50, 100, 250, 500, 1000] as const;

/**
 * How a handling state reads at a glance: waiting, explained, done.
 *
 * `highlight` for pending because that is what this palette means by "waiting on
 * somebody" — not a severity. A pending late order is not an error; it is work
 * nobody has picked up.
 */
const STATE_TONE: Record<LateOrderState, 'highlight' | 'blue' | 'success'> = {
  pending: 'highlight',
  commented: 'blue',
  handled: 'success',
};

/**
 * `late_preparation` → `Late preparation` (owner spec §12).
 *
 * The fallback when a value has no translation — which is every cause
 * operations add to the editable list, and every Yiji order status. Printing the
 * raw enum put underscores in a report people read and export.
 */
function causeLabel(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/**
 * One duration cell: still loading, not knowable, or minutes.
 *
 * A SKELETON and a DASH are different answers. The batch may still be in flight,
 * or the two stamps this leg needs may not both be in the order's history — an
 * order that never went out for delivery has no delivery time, and that is a
 * fact rather than a gap. Zero is never shown; it would read as "instant".
 */
function Leg({ loading, minutes }: { loading: boolean; minutes: number | null }) {
  if (loading)
    return (
      <span className="inline-block h-4 w-10 animate-pulse rounded bg-muted/60 align-middle" />
    );
  if (minutes === null) return <span className="text-muted-foreground/60">&mdash;</span>;
  return <>{minutes}</>;
}

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
  /*
   * THE HANDLING STATE (owner spec §10, 2026-09-29): Pending, Commented or
   * Handled. This replaces the old `action` filter, which offered
   * Compensated/Ignored — a vocabulary that no longer exists. Empty means all.
   *
   * NOT the order's own status, which is a separate thing entirely and has its
   * own column.
   */
  const [state, setState] = useState<LateOrderState | ''>('');
  /** The ORDER's own status from Yiji. Empty means every status. */
  const [orderStatus, setOrderStatus] = useState('');
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
  const [tab, setTab] = useState<'decisions' | 'agents' | 'summary'>('decisions');

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
  /* ONE rule for what a From/To pair means — see `businessDayWindow`. This page
     hand-rolled it; every other dated report hand-rolled something different. */
  const { fromIso, toIso } = businessDayWindow(from, to);
  const q = useLateOrderDecisions(fromIso, toIso);
  /*
   * THE PENDING ONES TOO (owner spec §11, 2026-09-29).
   *
   * A pending late order has NO DATABASE ROW — it exists only in Yiji's queue
   * until somebody comments on it or gives a coupon. So a register built from
   * `late_order_decisions` alone could only ever show the orders that had
   * already been dealt with, and "how many are waiting" was the one question it
   * could not answer.
   *
   * Its own query: Yiji is external and can fail on its own. A register that
   * went blank because the queue timed out would be worse than one showing
   * every decision, so a failure here costs the pending rows and nothing else.
   */
  const queue = useLateOrderQueue(fromIso, toIso);
  const all = useMemo(() => mergeLateOrders(q.data ?? [], queue.data ?? []), [q.data, queue.data]);

  /*
   * Narrowing happens HERE, not upstream: the window is already fetched, so an
   * order-number search or a cause filter is instant and costs nothing.
   */
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((r) => {
      /*
       * THE RANGE MEANS BUSINESS DAYS (owner, 2026-09-30): from=to=30/09 means
       * 30/09 08:00 through 01/10 04:00, not the calendar date.
       *
       * The fetch already widens its window to cover whole nights at both edges,
       * which is what gets the rows out of the database. This is the other half:
       * without it the widened window LEAKS — an order at 05:00 on 01/10 belongs
       * to 30/09's night and was fetched, but so was one at 06:00 that belongs to
       * 01/10 and should not be in a report claiming to cover 30/09. Comparing
       * business days makes the edges exact in both directions.
       */
      const rowDay = businessDay(r.date_created);
      if (rowDay) {
        if (rowDay < from || rowDay > to) return false;
      }
      if (kind && r.kind !== kind) return false;
      if (state && r.state !== state) return false;
      /* THE ORDER'S OWN STATUS (owner, 2026-09-30) — a different thing from the
         handling state above, and deliberately its own filter. */
      if (orderStatus && (r.order_status ?? '') !== orderStatus) return false;
      // One specific business day inside the range.
      if (bizDay && rowDay !== bizDay) return false;
      /* Matched on the RESOLVED name, which is what the column shows and what
         the picker offers — comparing raw ids would mean the filter and the
         table disagreed about who "Unassigned" is. */
      if (agent && agentName(r, unknown) !== agent) return false;
      if (!term) return true;
      return `${r.order_id ?? ''} ${r.brand_name ?? ''} ${r.restaurant_name ?? ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [all, search, kind, state, orderStatus, bizDay, agent, unknown, from, to]);
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

  /*
   * The ORDER statuses actually present in the window, alphabetically.
   *
   * Derived from the rows for the same reason the agents and business days are:
   * a fixed list of every Yiji status would mostly offer entries that lead to an
   * empty table, and would go stale the day Yiji adds one.
   */
  const orderStatuses = useMemo(() => {
    const seen = new Set<string>();
    for (const r of all) {
      const v = r.order_status?.trim();
      if (v) seen.add(v);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [all]);

  const businessDays = useMemo(() => {
    const seen = new Set<string>();
    for (const r of all) {
      const d = businessDay(r.date_created);
      if (d) seen.add(d);
    }
    return [...seen].sort().reverse();
  }, [all]);

  /*
   * PAGING, the same shape the ticket breakdown report uses (owner,
   * 2026-09-29): client-side over the window already fetched, up to 1000 rows a
   * page. No arbitrary date cap — the window is paged through upstream and the
   * result paged here.
   */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const pageCount = pageCountOf(rows.length, pageSize);
  /* Clamped rather than stored: narrowing the filters while sitting on page 9
     must not strand the reader on a page that no longer exists. */
  const current = Math.min(Math.max(1, page), pageCount);
  const paged = useMemo(
    () => rows.slice((current - 1) * pageSize, current * pageSize),
    [rows, current, pageSize],
  );

  /*
   * THE DURATIONS, for the OPEN PAGE ONLY.
   *
   * Each order id costs a call into Yiji's production API upstream and the
   * gateway caps a batch at 50, so this deliberately asks about what is on
   * screen rather than the whole window: a month's register is thousands of
   * rows, and fetching all of them would be thousands of calls for columns
   * nobody has scrolled to. Changing page fetches the next batch.
   */
  const eventTimes = useLateOrderEventTimes(
    useMemo(
      () =>
        paged
          .slice(0, 50)
          .map((r) => r.order_id?.trim())
          .filter((v): v is string => !!v),
      [paged],
    ),
  );
  const timesOf = useCallback(
    (orderId: string | null) =>
      orderEventTimes(eventTimes.data?.[orderId?.trim() ?? ''] ?? {}, Date.now()),
    [eventTimes.data],
  );

  /*
   * THE SUMMARY: how many late orders of each CAUSE (owner spec §15-§17).
   *
   * One row per Late Category with its count, and a Grand Total. Built from the
   * same filtered `rows` every other view uses, so the date range and every
   * other filter apply to it without a second query — and so the Grand Total
   * always equals what the register beside it lists.
   *
   * Causes are discovered from the DATA rather than enumerated: operations can
   * add one to the editable list at any time, and a hardcoded pair would leave
   * a new cause out of the summary silently. Ordered by count, biggest first —
   * the question this table answers is "what is going wrong most".
   *
   * Rows with no cause are counted under their own label rather than dropped:
   * a pending order has nobody's classification yet, and silently omitting them
   * would make the Grand Total disagree with the register.
   */
  const summary = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of rows) {
      const key = r.kind ?? '';
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return [...by.entries()]
      .map(([kind, count]) => ({
        kind,
        label: kind
          ? t(`lateOrders.kind.${kind}`, { defaultValue: causeLabel(kind) })
          : t('lateOrdersReport.uncategorised', { defaultValue: 'Not yet categorised' }),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [rows, t]);

  const exportSummary = () => {
    const header = [
      t('lateOrdersReport.lateCategory', { defaultValue: 'Late category' }),
      t('lateOrdersReport.count', { defaultValue: 'Count' }),
    ];
    const body: Array<Array<string | number>> = summary.map((r) => [r.label, r.count]);
    /* The Grand Total is a ROW of the file, as it is on screen: somebody opening
       this in a spreadsheet should see the same table they exported. */
    body.push([t('lateOrdersReport.grandTotal', { defaultValue: 'Grand total' }), rows.length]);
    downloadCsv(exportFileName('Late orders summary', {}), toCsv(header, body));
  };

  /* The LIVE threshold, because the waiting figure is `elapsed - threshold`
     and the threshold is an editable setting. */
  const threshold = useLateOrderThreshold();
  const stats = useMemo(
    () => agentLateStats(rows, unknown, threshold.data),
    [rows, unknown, threshold.data],
  );

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

  /*
   * WHO MAY OPEN THE ORDER PANEL — EVERY WeCare ROLE (owner, 2026-10-03).
   *
   * This used to be `canExport`, which names only WeCare Admin and Supervisor.
   * A WeCare AGENT therefore saw no button at all, reported it as "blocked",
   * and there was nothing on screen to say why — the cell simply was not
   * rendered.
   *
   * Agents are the people working these orders: refusing them the order behind
   * a late delivery is refusing them the job. Exporting is a different act —
   * it takes the whole register, addresses included, off the system — so that
   * one keeps its narrower list rather than being widened by association. The
   * two were only ever the same gate because they touch the same column.
   *
   * Matched by PREFIX, not by an exact list: `WeCare Agent`, `WeCare
   * Supervisor` and `WeCare Admin` all qualify, and a WeCare role added later
   * does not silently lose the button the way a hardcoded array would.
   *
   * Hiding is not securing and does not pretend to be: the snapshot rides on
   * the row this page already reads. This decides who is OFFERED it.
   */
  const canSeeOrder = isOwner || /^WeCare\b/i.test(user?.role?.name ?? '') || canExport;
  /** Which row is open. One at a time: two order panels is a page, not a table. */
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  /* The row the dialog is showing. Resolved from the id rather than stored, so
     a refetch that replaces the row object still shows current data. */
  const openRow = useMemo(
    () => (openOrder ? (rows.find((r) => r.id === openOrder) ?? null) : null),
    [openOrder, rows],
  );

  const exportByAgent = () => {
    const header = [
      t('lateOrdersReport.col.agent', { defaultValue: 'Agent' }),
      t('lateOrdersReport.col.touched', { defaultValue: 'Acted on' }),
      t('lateOrdersReport.col.compensated', { defaultValue: 'Compensated' }),
      t('lateOrdersReport.col.commented', { defaultValue: 'Commented' }),
      t('lateOrdersReport.col.preparation', { defaultValue: 'Preparation' }),
      t('lateOrdersReport.col.delivery', { defaultValue: 'Delivery' }),
      t('lateOrdersReport.col.avg', { defaultValue: 'Avg. minutes waiting' }),
    ];
    const body = stats.map((r) => [
      r.agent,
      r.touched,
      r.compensated,
      r.commented,
      r.latePreparation,
      r.lateDelivery,
      // Blank, not 0: no measurable orders is not an average of zero minutes.
      r.avgMinutes ?? '',
    ]);
    downloadCsv(exportFileName('Late orders by agent', {}), toCsv(header, body));
  };

  const exportDecisions = () => {
    const header = [
      t('lateOrdersReport.col.creationTime', { defaultValue: 'Creation time' }),
      t('lateOrdersReport.col.businessDay', { defaultValue: 'Business day' }),
      t('lateOrdersReport.col.order', { defaultValue: 'Order' }),
      t('lateOrdersReport.col.brandOnly', { defaultValue: 'Brand' }),
      t('lateOrdersReport.col.restaurant', { defaultValue: 'Restaurant' }),
      t('lateOrdersReport.col.customerMobile', { defaultValue: 'Customer mobile' }),
      t('lateOrdersReport.col.service', { defaultValue: 'Service time' }),
      t('lateOrdersReport.col.driverArrival', { defaultValue: 'Driver arrival' }),
      t('lateOrdersReport.col.deliveryTime', { defaultValue: 'Delivery time' }),
      t('lateOrdersReport.col.preparationTime', { defaultValue: 'Preparation time' }),
      t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' }),
      t('lateOrdersReport.col.status', { defaultValue: 'Status' }),
      t('lateOrdersReport.col.orderStatus', { defaultValue: 'Order status' }),
      t('lateOrdersReport.col.agent', { defaultValue: 'Agent' }),
      t('lateOrdersReport.col.reason', { defaultValue: 'Reason' }),
      t('lateOrdersReport.col.action', { defaultValue: 'Action taken' }),
    ];
    /*
     * EVERY FILTERED ROW, not just the open page — the file is what somebody
     * takes away, and paging is a reading convenience.
     *
     * The four DURATIONS are the exception: they are fetched for the visible
     * page only (each id is a call into Yiji upstream), so a row on another page
     * exports them blank rather than wrong. A blank cell is honest; a zero would
     * read as a measurement.
     */
    const body = rows.map((r) => {
      const day = businessDay(r.date_created);
      const times = timesOf(r.order_id);
      return [
        // ISO, not the dd/mm/yyyy on screen: a spreadsheet sorts and filters an
        // ISO stamp correctly and re-formats it for the reader either way.
        r.date_created ?? '',
        day ?? '',
        r.order_id ?? '',
        r.brand_name ?? '',
        r.restaurant_name ?? '',
        r.customer_phone ?? '',
        times.serviceMinutes ?? '',
        times.driverArrivalMinutes ?? '',
        times.deliveryMinutes ?? '',
        times.preparationMinutes ?? '',
        r.kind ? t(`lateOrders.kind.${r.kind}`, { defaultValue: causeLabel(r.kind) }) : '',
        t(`lateOrders.state.${r.state}`, { defaultValue: r.state }),
        r.order_status
          ? t(`commerce.orderStatuses.${r.order_status}`, {
              defaultValue: causeLabel(r.order_status),
            })
          : '',
        agentName(r, unknown),
        // The WHOLE text, not the two clamped lines the table shows: the export
        // exists precisely to get at what does not fit on screen.
        r.reason ?? '',
        r.action_taken ?? '',
      ];
    });
    downloadCsv(exportFileName('Late orders', {}), toCsv(header, body));
  };

  /*
   * THE THREE STATES, counted (owner spec §10/§11).
   *
   * `total` is every late order in the window now that pending ones are in the
   * register — it used to be `rows.length` under the name "handled", which was
   * true only while the register held decisions alone. Leaving that name on a
   * merged list would have quietly counted untouched orders as handled work.
   */
  const totals = useMemo(() => {
    const mins = rows
      .map((r) => r.minutes_elapsed)
      .filter((m): m is number => typeof m === 'number');
    return {
      total: rows.length,
      pending: rows.filter((r) => r.state === 'pending').length,
      commented: rows.filter((r) => r.state === 'commented').length,
      handled: rows.filter((r) => r.state === 'handled').length,
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
    /*
      THE SAME SHELL AS THE TICKET BREAKDOWN REPORT (owner, 2026-09-30: "the
      table scroll is still at the table level and not at the page level... the
      column names should be fixed and visible even on scroll").

      This was ONE element doing three jobs — owning the height, owning the
      scroll, and carrying `p-5` — and each of those broke the other two:

        - `p-5` on the scrollport put a 20px band above every `sticky top-0`
          header, so the column names pinned BELOW the padding with rows sliding
          through the gap;
        - the inner `overflow-x-auto` wrapper made a SECOND scrollport for the
          horizontal axis, which is why reaching the far columns meant scrolling
          to the foot of the table first;
        - and a `<Table>` with no surface had nothing establishing its width.

      Now the three-part split `AgentReportsPage` uses: this root owns the height
      and clips; the scrollport below owns BOTH axes with no vertical padding; and
      `w-max min-w-full` inside lets a wide table stretch the scrollport rather
      than escape its card. `TableSurface flow` then has the page's own
      scrollport directly above it, which is the one thing that makes its sticky
      header work. See [[layout-height-budget]].
    */
    <div className="flex h-full flex-col overflow-hidden">
      {/* NO VERTICAL PADDING HERE — see above. The spacing lives on the child,
          where it is spacing rather than a hole in the sticky ceiling. The
          scrollbars are styled visibly because the app's global thumb is
          deliberately faint, which is right for a page and wrong for the one
          control that reaches half a report's columns. */}
      <div className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] flex-1 overflow-auto px-5">
        <div className="w-max min-w-full space-y-6 py-5">
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
                    label: t('lateOrders.kind.late_preparation', {
                      defaultValue: 'Late preparation',
                    }),
                  },
                ],
              },
              {
                /* STATUS, not Decision (owner spec §10). The three handling states,
               in the order an order passes through them. */
                key: 'state',
                label: t('lateOrdersReport.col.status', { defaultValue: 'Status' }),
                value: state,
                onChange: (v: string) => setState(v as LateOrderState | ''),
                options: [
                  {
                    value: 'pending',
                    label: t('lateOrders.state.pending', { defaultValue: 'Pending' }),
                  },
                  {
                    value: 'commented',
                    label: t('lateOrders.state.commented', { defaultValue: 'Commented' }),
                  },
                  {
                    value: 'handled',
                    label: t('lateOrders.state.handled', { defaultValue: 'Handled' }),
                  },
                ],
              },
              {
                /* THE ORDER'S OWN STATUS (owner, 2026-09-30) — separate from the
               handling Status above, which is ours. Options come from the data
               actually present, like the agent and business-day pickers: a fixed
               list of Yiji statuses would mostly offer entries leading to an
               empty table, and would go stale the day Yiji adds one. */
                key: 'orderStatus',
                label: t('lateOrdersReport.col.orderStatus', { defaultValue: 'Order status' }),
                value: orderStatus,
                onChange: setOrderStatus,
                options: orderStatuses.map((v) => ({
                  value: v,
                  label: t(`commerce.orderStatuses.${v}`, { defaultValue: causeLabel(v) }),
                })),
              },
            ]}
            /*
          EVERY filter is listed here, and every one is reset below.
          Omitted from `filtering` its Clear button never appears; omitted from
          `onClear` it survives a clear that claims to remove everything. The
          DATE RANGE is handled by the bar itself now — it owns those fields, and
          every page that had to remember it forgot it.
        */
            filtering={!!search || !!kind || !!state || !!orderStatus || !!bizDay || !!agent}
            onClear={() => {
              setSearch('');
              setKind('');
              setState('');
              setOrderStatus('');
              setBizDay('');
              setAgent('');
              /* The range too — `reset()` forgets the stored value and returns to the
             default month, so Clear means what it says. */
              reset();
            }}
          />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ReportKpi
              label={t('lateOrdersReport.total', { defaultValue: 'Late orders' })}
              value={String(totals.total)}
              tone="blue"
            />
            {/* PENDING FIRST among the states: it is the one that needs somebody to
            do something, and the only one that was invisible before. */}
            <ReportKpi
              label={t('lateOrders.state.pending', { defaultValue: 'Pending' })}
              value={String(totals.pending)}
              tone="amber"
            />
            <ReportKpi
              label={t('lateOrders.state.handled', { defaultValue: 'Handled' })}
              value={String(totals.handled)}
              tone="green"
              hint={t('lateOrdersReport.commentedCount', {
                count: totals.commented,
                defaultValue: '{{count}} commented',
              })}
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
                defaultValue: 'No late orders in this window',
              })}
              description={t('lateOrdersReport.noneBody', {
                defaultValue:
                  'No delivery order passed the late threshold in this window, and none was commented on or compensated.',
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
                    [
                      'decisions',
                      t('lateOrdersReport.register', { defaultValue: 'Order decisions' }),
                    ],
                    ['summary', t('lateOrdersReport.summary', { defaultValue: 'Summary' })],
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
              {/*
            THE SUMMARY (owner spec §15-§17): Late Category against Count, with
            a Grand Total, over the date range the filter bar already sets.

            No pager: this table has one row per cause, and there are a handful
            of causes. A pager on three rows is furniture.
          */}
              {tab === 'summary' && (
                <Card className="p-0">
                  <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-5">
                    <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {t('lateOrdersReport.summary', { defaultValue: 'Summary' })}
                    </h3>
                    {canExport && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="ms-auto"
                        onClick={exportSummary}
                        disabled={summary.length === 0}
                      >
                        {t('lateOrdersReport.exportCsv', { defaultValue: 'Export to CSV' })}
                      </Button>
                    )}
                  </div>
                  <Table>
                    <thead>
                      <Tr>
                        <Th>
                          {t('lateOrdersReport.lateCategory', { defaultValue: 'Late category' })}
                        </Th>
                        <Th>{t('lateOrdersReport.count', { defaultValue: 'Count' })}</Th>
                      </Tr>
                    </thead>
                    <tbody>
                      {summary.map((r) => (
                        <Tr key={r.kind || 'uncategorised'}>
                          <Td>{r.label}</Td>
                          <Td className="tabular-nums">{r.count}</Td>
                        </Tr>
                      ))}
                      {/* THE GRAND TOTAL is `rows.length`, not a sum of the rows
                      above — the two are equal by construction, and taking it
                      from the source means they cannot silently diverge if a
                      row ever fails to land in a category. */}
                      <Tr>
                        <Td className="font-semibold">
                          {t('lateOrdersReport.grandTotal', { defaultValue: 'Grand total' })}
                        </Td>
                        <Td className="font-semibold tabular-nums">{rows.length}</Td>
                      </Tr>
                    </tbody>
                  </Table>
                </Card>
              )}

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
                  <TableSurface flow>
                    <Table>
                      <thead>
                        <Tr>
                          <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                          <Th>{t('lateOrdersReport.col.touched', { defaultValue: 'Acted on' })}</Th>
                          <Th>
                            {t('lateOrdersReport.col.compensated', { defaultValue: 'Compensated' })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.commented', { defaultValue: 'Commented' })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.preparation', { defaultValue: 'Preparation' })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.delivery', { defaultValue: 'Delivery' })}
                          </Th>
                          {/* NAMED for what it measures. "Avg. minutes" said
                          nothing about from when, and the old reading — time
                          since the customer ordered — described the kitchen
                          rather than the agent. */}
                          <Th>
                            {t('lateOrdersReport.col.avg', {
                              defaultValue: 'Avg. minutes waiting',
                            })}
                            <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                              {t('lateOrdersReport.col.avgHint', {
                                defaultValue: 'on the queue before deciding',
                              })}
                            </span>
                          </Th>
                        </Tr>
                      </thead>
                      <tbody>
                        {stats.map((s) => (
                          <Tr key={s.agent}>
                            <Td className="whitespace-nowrap font-medium">{s.agent}</Td>
                            <Td className="tabular-nums">{s.touched}</Td>
                            <Td className="tabular-nums">{s.compensated}</Td>
                            <Td className="tabular-nums">{s.commented}</Td>
                            <Td className="tabular-nums">{s.latePreparation}</Td>
                            <Td className="tabular-nums">{s.lateDelivery}</Td>
                            <Td className="tabular-nums">{s.avgMinutes ?? '-'}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </TableSurface>
                  {/*
                    ONE dialog for the whole register, outside the table.
                    Mounted only while open, so a page of rows never pays for
                    snapshots nobody asked to see.
                  */}
                  <Modal
                    open={!!openOrder}
                    onClose={() => setOpenOrder(null)}
                    size="lg"
                    title={t('lateOrdersReport.snapshot.title', {
                      order: openRow?.order_id ?? '',
                      defaultValue: 'Order {{order}}',
                    })}
                  >
                    {openRow && <OrderSnapshotPanel snapshot={openRow.order_snapshot} />}
                  </Modal>
                  <TablePager
                    page={current}
                    onPage={setPage}
                    pageSize={pageSize}
                    onPageSize={setPageSize}
                    total={rows.length}
                    pageSizes={REGISTER_PAGE_SIZES}
                    labels={{
                      rowsPerPage: String(
                        t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' }),
                      ),
                      previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
                      next: String(t('agentReports.next', { defaultValue: 'Next' })),
                      showing: ({ from: f, to: to2, total }) =>
                        String(
                          t('complaintReport.showingRange', {
                            defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
                            from: f,
                            to: to2,
                            total,
                          }),
                        ),
                    }}
                  />
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
                  <TableSurface flow>
                    <Table>
                      <thead>
                        <Tr>
                          {/* CREATION TIME, not "When" (owner spec §12) — when the
                          ORDER was created, which is what the column has always
                          shown and what an admin reading a register needs. */}
                          <Th>
                            {t('lateOrdersReport.col.creationTime', {
                              defaultValue: 'Creation time',
                            })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.businessDay', {
                              defaultValue: 'Business day',
                            })}
                          </Th>
                          <Th>{t('lateOrdersReport.col.order', { defaultValue: 'Order' })}</Th>
                          {/* §14 — BRAND AND RESTAURANT AS SEPARATE NAMED COLUMNS,
                          plus the customer's mobile. They were one joined cell,
                          which cannot be sorted, filtered or read into a
                          spreadsheet as two facts. */}
                          <Th>{t('lateOrdersReport.col.brandOnly', { defaultValue: 'Brand' })}</Th>
                          <Th>
                            {t('lateOrdersReport.col.restaurant', { defaultValue: 'Restaurant' })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.customerMobile', {
                              defaultValue: 'Customer mobile',
                            })}
                          </Th>
                          {/* §12 — SERVICE TIME here too, on the same rule as the
                          agent's queue: driver-accept to CLOSE. */}
                          <Th>
                            {t('lateOrdersReport.col.service', { defaultValue: 'Service time' })}
                          </Th>
                          {/* §13 — the three legs. */}
                          <Th>
                            {t('lateOrdersReport.col.driverArrival', {
                              defaultValue: 'Driver arrival',
                            })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.deliveryTime', {
                              defaultValue: 'Delivery time',
                            })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.preparationTime', {
                              defaultValue: 'Preparation time',
                            })}
                          </Th>
                          <Th>
                            {t('lateOrdersReport.col.cause', { defaultValue: 'Source of delay' })}
                          </Th>
                          {/* §10 — STATUS, and it is the HANDLING state. The order's
                          own status is the column beside it, deliberately
                          separate: an order can be force-closed upstream and
                          still be pending for WeCare. */}
                          <Th>{t('lateOrdersReport.col.status', { defaultValue: 'Status' })}</Th>
                          <Th>
                            {t('lateOrdersReport.col.orderStatus', {
                              defaultValue: 'Order status',
                            })}
                          </Th>
                          <Th>{t('lateOrdersReport.col.agent', { defaultValue: 'Agent' })}</Th>
                          <Th>{t('lateOrdersReport.col.reason', { defaultValue: 'Reason' })}</Th>
                          <Th>
                            {t('lateOrdersReport.col.action', { defaultValue: 'Action taken' })}
                          </Th>
                          {/* The toggle's own column, titled for screen readers only
                          — a visible heading over a chevron reads as a column of
                          data rather than a control. */}
                          {canSeeOrder && (
                            <Th className="w-24">
                              <span className="sr-only">
                                {t('lateOrdersReport.snapshot.items', { defaultValue: 'Items' })}
                              </span>
                            </Th>
                          )}
                        </Tr>
                      </thead>
                      <tbody>
                        {paged.map((r) => (
                          <Fragment key={r.id}>
                            <Tr>
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
                              <Td className="whitespace-nowrap tabular-nums">
                                {r.order_id ?? '-'}
                              </Td>
                              {/* §14 — the NAMES, each in its own column. */}
                              <Td className="max-w-[12rem] truncate">{r.brand_name || '-'}</Td>
                              <Td className="max-w-[12rem] truncate">{r.restaurant_name || '-'}</Td>
                              <Td className="whitespace-nowrap tabular-nums">
                                {r.customer_phone || '-'}
                              </Td>
                              {/* §12/§13 — the four durations, all from the order's
                            status history via `orderEventTimes`. Only the rows
                            on the open PAGE are fetched, so these are blank
                            until that batch lands. */}
                              <Td className="whitespace-nowrap tabular-nums">
                                <Leg
                                  loading={eventTimes.isLoading}
                                  minutes={timesOf(r.order_id).serviceMinutes}
                                />
                              </Td>
                              <Td className="whitespace-nowrap tabular-nums">
                                <Leg
                                  loading={eventTimes.isLoading}
                                  minutes={timesOf(r.order_id).driverArrivalMinutes}
                                />
                              </Td>
                              <Td className="whitespace-nowrap tabular-nums">
                                <Leg
                                  loading={eventTimes.isLoading}
                                  minutes={timesOf(r.order_id).deliveryMinutes}
                                />
                              </Td>
                              <Td className="whitespace-nowrap tabular-nums">
                                <Leg
                                  loading={eventTimes.isLoading}
                                  minutes={timesOf(r.order_id).preparationMinutes}
                                />
                              </Td>
                              {/* §12 — the CAUSE, spelled out. `lateOrders.kind.*`
                            translates the seeded two; anything operations added
                            falls back to `causeLabel`, which turns
                            `late_preparation` into "Late preparation" rather
                            than printing the raw enum with its underscore. */}
                              <Td className="whitespace-nowrap">
                                {r.kind
                                  ? t(`lateOrders.kind.${r.kind}`, {
                                      defaultValue: causeLabel(r.kind),
                                    })
                                  : '-'}
                              </Td>
                              {/* §10 — the HANDLING state. */}
                              <Td>
                                <Pill tone={STATE_TONE[r.state]} size="sm">
                                  {t(`lateOrders.state.${r.state}`, { defaultValue: r.state })}
                                </Pill>
                              </Td>
                              {/* The ORDER's own status — a different fact, and the
                            spec is explicit that the two must not be confused. */}
                              <Td className="whitespace-nowrap text-muted-foreground">
                                {r.order_status
                                  ? t(`commerce.orderStatuses.${r.order_status}`, {
                                      defaultValue: causeLabel(r.order_status),
                                    })
                                  : '-'}
                              </Td>
                              <Td className="whitespace-nowrap">{agentName(r, unknown)}</Td>
                              <Td className="max-w-[22rem]">
                                <span
                                  className="line-clamp-2 block leading-snug"
                                  title={r.reason ?? ''}
                                >
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
                              {/* THE ORDER, from the stored snapshot. No network call:
                            it is already on the row. */}
                              {canSeeOrder && (
                                <Td className="whitespace-nowrap">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    aria-haspopup="dialog"
                                    onClick={() => setOpenOrder(r.id)}
                                  >
                                    {t('lateOrdersReport.snapshot.view', {
                                      defaultValue: 'Order',
                                    })}
                                  </Button>
                                </Td>
                              )}
                            </Tr>
                            {/*
                          A DIALOG, NOT A SECOND ROW (owner, 2026-10-01).

                          This used to expand inline, which pushed every row
                          below it down and left the order boxed inside the
                          table's own horizontal scroll — on a register this
                          wide the panel was frequently off-screen to begin
                          with. The agent portal's "Cart & tracking" has always
                          been a modal for the same reason, and the two screens
                          should not read differently.

                          The dialog itself is rendered ONCE, outside the table
                          — see `openRow` below. One overlay, not one per row.
                        */}
                          </Fragment>
                        ))}
                      </tbody>
                    </Table>
                  </TableSurface>
                  <TablePager
                    page={current}
                    onPage={setPage}
                    pageSize={pageSize}
                    onPageSize={setPageSize}
                    total={rows.length}
                    pageSizes={REGISTER_PAGE_SIZES}
                    labels={{
                      rowsPerPage: String(
                        t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' }),
                      ),
                      previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
                      next: String(t('agentReports.next', { defaultValue: 'Next' })),
                      showing: ({ from: f, to: to2, total }) =>
                        String(
                          t('complaintReport.showingRange', {
                            defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
                            from: f,
                            to: to2,
                            total,
                          }),
                        ),
                    }}
                  />
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
