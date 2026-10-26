import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  BellIcon,
  ChartIcon,
  ClockIcon,
  cn,
  DateField,
  EmptyState,
  formatDateTime,
  HBarChart,
  InboxIcon,
  MeterBar,
  Pill,
  ProgressRing,
  SelectMenu,
  Skeleton,
  TrendChart,
  type ChartSeries,
  UsersIcon,
  ZapIcon,
} from '@yiji/ui';
import {
  agentPerformance,
  comparisonRows,
  dailyTrend,
  defaultPerformanceRange,
  firstResponseSec,
  formatDuration,
  matchesSearch,
  performanceSummary,
  timeToSolveSec,
  agentInitiatedSummary,
  awaitingCustomer,
} from '@yiji/reports';
import { directus } from '../../lib/directus.js';
import { useSlaHours } from '../../lib/sla-hours.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { exportFileName } from '@yiji/shared-config';
import { ViewSwitch } from '../../components/ViewSwitch.js';
import { FIELD_LABEL, FILTER_CARD, PAGE_BODY, PageHeader } from '../../components/shell/Page.js';
import {
  useChatTimings,
  useCsatByConversation,
  type AdminChatTiming,
  type PerformanceFilters,
} from './api.js';
import { NoMatchRow, CouponsTab, TicketsTab } from './WorkTabs.js';
import { Tile } from './Tile.js';
import { ExportCsvButton } from '../../components/ExportCsvButton.js';
import { SearchField } from '../../components/SearchField.js';

/**
 * Agent performance for the admin console.
 *
 * The same measures, the same layout and — crucially — the SAME arithmetic as
 * the agent portal: every number here comes out of @yiji/reports, so a
 * supervisor and an agent can never be looking at different figures for the
 * same week. What differs is only what a row does: nothing here opens a chat,
 * because an admin is reviewing the team rather than working the queue.
 *
 * LIKE THE USER PORTAL (owner, 2026-10-12): "we need a search by order id,
 * ticket id, coupon code and stuff. then we need 3 different: chats, tickets,
 * coupons". The search and the coupon stages are the agent portal's own, moved
 * to @yiji/reports so both portals match a query the same way; the Tickets and
 * Coupons tabs are a port of its WorkTabs (see WorkTabs.tsx).
 *
 * CHARTS ARE GROUPED BY UNIT, never mixed. A count of chats and an average in
 * seconds on one shared axis draws "9 chats" as an invisible sliver beside
 * "4m 12s" — a chart that lies about which number is bigger.
 *
 * The met/missed toggle that used to sit at the top is gone. It split every
 * number on the page into two half-populations before the reader had seen the
 * whole one, and "how many missed" is a single tile, not a mode.
 */
const DEFAULT_TARGET_MIN = 5;

const countFmt = (v: number) => String(v);

type Filters = PerformanceFilters;

/** Chats, Tickets and Coupons — the agent portal's three sub-pages (owner, 2026-10-12). */
const TABS = ['chats', 'tickets', 'coupons'] as const;
type PerformanceTab = (typeof TABS)[number];
const isTab = (v: unknown): v is PerformanceTab =>
  typeof v === 'string' && (TABS as readonly string[]).includes(v);

interface SavedView {
  filters?: Filters;
  tab?: PerformanceTab;
  search?: string;
}

/*
 * The filters survive leaving the page, per tab (owner, 2026-10-07). `:v2`
 * since the page stopped opening on all time (owner, 2026-10-12): the old key
 * held `{}` for everyone who had opened the page, which would have kept them on
 * the slow all-time read the new default exists to avoid.
 */
const VIEW_KEY = 'admin-agent-performance:v2';

function useAgentList() {
  return useQuery({
    queryKey: ['perf-agents'],
    // The roster changes rarely; the portal's 30s poll is for queues.
    staleTime: 5 * 60_000,
    refetchInterval: false,
    queryFn: () =>
      directus.request(
        readUsers({ limit: -1, fields: ['id', 'first_name', 'last_name', 'email'] }),
      ) as Promise<Array<{ id: string; first_name: string | null; email: string | null }>>,
  });
}

export function AgentPerformancePage() {
  const { t } = useTranslation();
  // Export is offered only with `export_data` (owner, 2026-10-06).
  const { can } = useAuth();
  const canExport = can('export_data');
  const canSeeChats = can('view_chat_breakdown');
  const agents = useAgentList();
  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) {
      m.set(a.id, a.first_name?.trim() || a.email?.trim() || a.id);
    }
    return m;
  }, [agents.data]);

  const saved = useMemo<SavedView | null>(() => {
    try {
      const raw = sessionStorage.getItem(VIEW_KEY);
      return raw ? (JSON.parse(raw) as SavedView) : null;
    } catch {
      return null;
    }
  }, []);
  /* OPENS ON YESTERDAY'S BUSINESS DAY THROUGH TODAY, as the agent portal does
     (owner, 2026-10-12). All time was the main reason the page was slow. */
  const [filters, setFilters] = useState<Filters>(
    () => saved?.filters ?? { ...defaultPerformanceRange() },
  );
  /* THE RESPONSE TARGET IS FIXED (owner, 2026-10-25: remove "Answer within
     (minutes)" from the filters, as the agent portal did). Chats are scored
     against the default five minutes, and the tile says so. */
  const targetMin = DEFAULT_TARGET_MIN;

  /* THE TAB LIVES IN THE URL (`?tab=tickets`), so a link opens that sub-page;
     with none it is Chats (owner, 2026-10-15). The remembered tab is NOT
     restored any more: clicking Chats drops `?tab`, and falling back to the
     remembered Tickets then made Chats impossible to open. */
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab');
  const tab: PerformanceTab = isTab(urlTab) ? urlTab : 'chats';
  const setTab = (next: PerformanceTab) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        if (next === 'chats') out.delete('tab');
        else out.set('tab', next);
        return out;
      },
      { replace: true },
    );

  /*
   * SEARCH (owner, 2026-10-12): order id, ticket id, coupon code, customer
   * number, title. Applies to the ACTIVE tab's table; the headline numbers keep
   * counting the whole range. Lightly debounced so a long number does not
   * re-filter on every digit.
   */
  const [searchDraft, setSearchDraft] = useState(saved?.search ?? '');
  const [search, setSearch] = useState(saved?.search ?? '');
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchDraft), 200);
    return () => window.clearTimeout(id);
  }, [searchDraft]);

  useEffect(() => {
    try {
      const view: SavedView = { filters, tab, search };
      sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* storage unavailable: the page simply forgets */
    }
  }, [filters, tab, search]);

  /* Chats are read only while the Chats tab is open; Tickets and Coupons read
     inside their own tab components — a tab's data loads when it is opened. */
  const onChats = tab === 'chats';
  const timings = useChatTimings(filters, onChats);
  /* The same range for EVERY agent, read only while one agent is picked: an
     agent's totals row must be the row they have in the full table, and part
     of it - first replies they sent on colleagues' chats - lives on chats the
     agent filter leaves out (owner, 2026-10-26: filtered vs unfiltered differed). */
  const { agentId: _picked, ...everyAgent } = filters;
  const allTimings = useChatTimings(everyAgent, onChats && !!filters.agentId);
  /* WORKING HOURS (owner, 2026-10-08): every duration on this page counts only
     the chat SLA policy's working hours, as the SLA engine does. Stamped on each
     chat so every shared function below reads the same clock. */
  const slaHours = useSlaHours();
  const chatHours = slaHours.data?.chat ?? null;
  // Names attached here, not in the query — see the note on useChatTimings.
  const chats = useMemo<AdminChatTiming[]>(
    () =>
      (timings.data ?? []).map((c) => ({
        ...c,
        businessHours: chatHours,
        // NEVER the raw id. A 36-character uuid beside real names is not a
        // degraded label, it is an unreadable one — and it happens for real:
        // the router can assign a chat to an account `useAgents` filters out,
        // and a /users error leaves every name unresolved. The skeleton gate
        // below also waits for the names, so the first paint cannot show one.
        agentName: c.agentId
          ? (agentNames.get(c.agentId) ??
            t('performance.unknownAgent', { defaultValue: 'Unknown agent' }))
          : t('performance.unassigned', { defaultValue: 'General' }),
      })),
    [timings.data, agentNames, t, chatHours],
  );

  const volumeSeries: ChartSeries[] = [
    // The headline series carries the BRAND, not a neighbouring data hue —
    // --sky at L 0.72 read pale beside an indigo interface.
    { key: 'chats', label: t('performance.chats', { defaultValue: 'Chats' }), tone: 'primary' },
  ];
  const commonSeries: ChartSeries[] = [
    {
      key: 'common',
      label: t('performance.commonChats', { defaultValue: 'Common chats taken' }),
      tone: 'success',
    },
  ];
  /*
   * Two lines that must be told apart at a glance.
   *
   * They were `primary` and `violet`, which stopped being two colours when the
   * brand moved to indigo: the palette keeps every CRM hue within ~35 degrees
   * of 278, so the brand and the violet accent are neighbours. On this chart
   * that made first response and time to solve the same purple, and the only
   * way to read the pair was the legend order.
   *
   * Sky against jade instead — opposite ends of the semantic range, and both
   * far enough from the indigo interface that neither reads as chrome.
   */
  const timeSeries: ChartSeries[] = [
    {
      key: 'first',
      label: t('performance.firstResponse', { defaultValue: 'First response' }),
      tone: 'sky',
    },
    {
      key: 'solve',
      label: t('performance.timeToSolve', { defaultValue: 'Time to solve' }),
      tone: 'success',
    },
  ];

  const targetSec = targetMin * 60;
  const summary = useMemo(() => performanceSummary(chats, targetSec), [chats, targetSec]);
  /* Chats an AGENT started, read on their own terms (owner, 2026-10-07). */
  const outreach = useMemo(() => agentInitiatedSummary(chats), [chats]);
  const compare = useMemo(
    () =>
      comparisonRows(chats, (n) => t('performance.chatsCount', { defaultValue: '{{n}} chats', n })),
    [chats, t],
  );
  const trend = useMemo(() => dailyTrend(chats), [chats]);
  /** The full numbers per agent — this page's drill-down, since no row opens a chat. */
  const rows = useMemo(() => {
    const population = filters.agentId
      ? (allTimings.data ?? []).map((c) => ({
          ...c,
          businessHours: chatHours,
          agentName: c.agentId ? (agentNames.get(c.agentId) ?? '') : '',
        }))
      : chats;
    const all = agentPerformance(population, undefined, agentNames);
    /* ONE AGENT PICKED, ONE ROW (owner, 2026-10-26). A colleague who sent the
       first reply on one of this agent's chats gets a row of their own in the
       full table; under this agent's filter it read as a duplicate of them. */
    return filters.agentId ? all.filter((r) => r.agentId === filters.agentId) : all;
  }, [chats, allTimings.data, chatHours, agentNames, filters.agentId]);

  /**
   * Export what is on screen, not a second query: the CSV is built from the
   * same `rows` the table renders, so a filtered view exports the filtered
   * numbers and the file can never disagree with the page that produced it.
   *
   * Durations leave as SECONDS. A spreadsheet can average a number; it cannot
   * average "5h 6m", and an export exists to be calculated with.
   */
  const exportCsv = () => {
    const header = [
      t('performance.agent', { defaultValue: 'Agent' }),
      t('performance.chats', { defaultValue: 'Chats' }),
      t('performance.answered', { defaultValue: 'Answered' }),
      t('performance.unanswered', { defaultValue: 'No reply yet' }),
      t('performance.solved', { defaultValue: 'Solved' }),
      t('performance.commonChats', { defaultValue: 'Common chats taken' }),
      t('performance.avgFirstSec', { defaultValue: 'First response (seconds, avg)' }),
      t('performance.medFirstSec', { defaultValue: 'First response (seconds, median)' }),
      t('performance.avgSolveSec', { defaultValue: 'Time to solve (seconds, avg)' }),
      t('performance.medSolveSec', { defaultValue: 'Time to solve (seconds, median)' }),
    ];
    const body = rows.map((r) => [
      r.agentName,
      r.chats,
      r.answered,
      r.unanswered,
      r.solved,
      r.commonChats,
      r.avgFirstResponseSec ?? '',
      r.medianFirstResponseSec ?? '',
      r.avgTimeToSolveSec ?? '',
      r.medianTimeToSolveSec ?? '',
    ]);
    // Name the file after the window it covers, so two exports taken on the
    // same day from different date filters cannot be mistaken for each other.
    const scope =
      filters.from || filters.to
        ? `${filters.from ?? 'start'} to ${filters.to ?? 'today'}`
        : 'all time';
    downloadCsv(exportFileName('Agent performance', { scope }), toCsv(header, body));
  };
  /* CSAT joined onto the same chats the rest of the page measures, so the
     rating can never describe a different population than the timings beside
     it. `null` where nobody rated — an unrated agent is not a zero. */
  const csat = useCsatByConversation(filters, onChats);
  const csatByAgent = useMemo(() => {
    const acc = new Map<string, { sum: number; n: number }>();
    for (const c of chats) {
      const score = csat.data?.get(c.conversationId);
      if (typeof score !== 'number') continue;
      const key = c.agentId ?? '';
      const cur = acc.get(key) ?? { sum: 0, n: 0 };
      cur.sum += score;
      cur.n += 1;
      acc.set(key, cur);
    }
    const out = new Map<string, { avg: number; n: number }>();
    for (const [k, v] of acc) out.set(k, { avg: v.sum / v.n, n: v.n });
    return out;
  }, [chats, csat.data]);

  /*
   * Chat by chat — NEWEST FIRST (owner, 2026-09-16).
   *
   * This led with the slowest chats, and chats nobody answered above those,
   * on the reasoning that "no reply" is what a supervisor must act on today.
   * That reasoning still holds, and it is not what this table is for: ranking
   * rows by a measure means a chat MOVES as its timings change, so the one you
   * are looking for is wherever it happens to have landed. A date sort puts it
   * where you expect it, every time.
   *
   * The unanswered chats have not been hidden — the response column says "No
   * reply" on every one of them, and the charts above this table are where
   * "who is slow" is actually answered. If leading with them turns out to
   * matter more than finding a chat by when it happened, the honest fix is a
   * sortable column header rather than a fixed order that serves one of the
   * two jobs.
   *
   * Changed in BOTH portals together: the two copies of this table have always
   * shared an ordering rule, and having them disagree would mean the same
   * screen answers differently depending on who opened it.
   */
  const breakdownAll = useMemo(
    () =>
      chats
        .map((c) => ({ chat: c, first: firstResponseSec(c), solve: timeToSolveSec(c) }))
        .sort((a, b) => {
          const at = a.chat.startedAt ? Date.parse(a.chat.startedAt) : null;
          const bt = b.chat.startedAt ? Date.parse(b.chat.startedAt) : null;
          if (at == null && bt == null) return 0;
          // Missing dates sink: they are absent data, not recent work.
          if (at == null) return 1;
          if (bt == null) return -1;
          return bt - at;
        }),
    [chats],
  );
  /* The search narrows the TABLE only, never the tiles above it — the agent
     portal's rule, through the same shared matcher (owner, 2026-10-12). */
  const breakdown = useMemo(
    () =>
      breakdownAll.filter(({ chat }) =>
        matchesSearch(search, {
          phones: [chat.customerPhone, chat.customer],
          text: [chat.conversationId, chat.ticketId, chat.orderId, chat.subject, chat.customer],
        }),
      ),
    [breakdownAll, search],
  );

  const dash = <span className="text-muted-foreground/50">—</span>;
  const durFmt = (v: number) => formatDuration(v) ?? '—';
  // The volume charts can only be empty if no chat carries a usable date at
  // all — unreachable today, but a hardcoded English string is not something to
  // leave lying in an Arabic interface on the strength of "unreachable".
  const nothingToChart = t('performance.nothingToChart', {
    defaultValue: 'Nothing to chart yet.',
  });
  const nothingMeasured = t('performance.nothingMeasured', {
    defaultValue: 'No chat in this range has been answered yet, so there is nothing to plot.',
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header band, same anatomy as every other console page — without it the
          filter card sat colliding with the navbar. */}
      <PageHeader
        title={t('performance.title', { defaultValue: 'Agent performance' })}
        actions={
          /* Exports the per-agent CHAT totals, so it sits with the Chats tab. */
          canExport && onChats ? (
            <ExportCsvButton
              onExport={exportCsv}
              count={rows.length}
              label={t('agentReports.exportCsvCount', {
                count: rows.length,
                defaultValue: 'Export CSV ({{count}})',
              })}
            />
          ) : undefined
        }
      />

      {/* The shell's <main> is overflow-hidden by design — every page owns its
          scroll. This one didn't, so everything below the first screenful was
          simply unreachable. */}
      <div className={cn(PAGE_BODY, 'overflow-x-hidden')}>
        {/* Full width on the header's gutter (Rapport skin) - the centred 6xl
            column sat off-centre from the title above it. */}
        <div className="space-y-4">
          <div className={cn(FILTER_CARD, 'flex flex-wrap items-end gap-3')}>
            {/* In the filter card with the agent and the dates, not up beside
                Export CSV (owner, 2026-10-13). Sized on the wrapper: Input's
                base carries w-full. */}
            <Field label={t('performance.search', { defaultValue: 'Search' })}>
              <SearchField
                className="w-[min(16rem,calc(100vw-5rem))]"
                inputClassName="h-8"
                value={searchDraft}
                onValueChange={setSearchDraft}
                aria-label={t('performance.search', { defaultValue: 'Search' })}
                placeholder={t('performance.searchPlaceholder', {
                  defaultValue: 'Order, ticket, coupon code or customer number…',
                })}
              />
            </Field>
            <Field label={t('performance.agent', { defaultValue: 'Agent' })}>
              <SelectMenu
                size="sm"
                className="w-[12rem]"
                value={filters.agentId ?? ''}
                onChange={(v) => setFilters((f) => ({ ...f, agentId: v }))}
                aria-label={t('performance.agent', { defaultValue: 'Agent' })}
                options={[
                  { value: '', label: t('performance.allAgents', { defaultValue: 'All agents' }) },
                  ...(agents.data ?? []).map((a) => ({
                    value: a.id,
                    label: a.first_name?.trim() || a.email?.trim() || a.id,
                  })),
                ]}
              />
            </Field>
            <Field label={t('performance.from', { defaultValue: 'From' })}>
              {/* Width on the wrapper — Input's base carries `w-full` and `cn` does
              not merge Tailwind classes, so a width passed through className is
              not reliably the winner. */}
              <span className="block w-[9.5rem]">
                <DateField
                  size="sm"
                  aria-label={t('performance.from', { defaultValue: 'From' })}
                  value={filters.from ?? ''}
                  onChange={(v) => setFilters((f) => ({ ...f, from: v }))}
                />
              </span>
            </Field>
            <Field label={t('performance.to', { defaultValue: 'To' })}>
              <span className="block w-[9.5rem]">
                <DateField
                  size="sm"
                  aria-label={t('performance.to', { defaultValue: 'To' })}
                  value={filters.to ?? ''}
                  onChange={(v) => setFilters((f) => ({ ...f, to: v }))}
                />
              </span>
            </Field>
          </div>

          <ViewSwitch
            value={tab}
            onChange={setTab}
            label={t('performance.tabs', { defaultValue: 'Performance views' })}
            options={[
              { value: 'chats', label: t('performance.tabChats', { defaultValue: 'Chats' }) },
              { value: 'tickets', label: t('performance.tabTickets', { defaultValue: 'Tickets' }) },
              { value: 'coupons', label: t('performance.tabCoupons', { defaultValue: 'Coupons' }) },
            ]}
          />

          {tab === 'tickets' ? (
            <TicketsTab filters={filters} search={search} agentNames={agentNames} />
          ) : tab === 'coupons' ? (
            <CouponsTab filters={filters} search={search} />
          ) : (
            <>
              {timings.isLoading || agents.isLoading || slaHours.isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-[5.5rem] w-full rounded-2xl" />
                  <Skeleton className="h-56 w-full rounded-2xl" />
                </div>
              ) : chats.length === 0 ? (
                // Composed empty state on the card surface — a bare sentence floating
                // in a screenful of canvas read as a rendering failure.
                <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
                  <EmptyState
                    icon={<InboxIcon size={22} />}
                    title={t('performance.empty', {
                      defaultValue: 'No chats match these filters.',
                    })}
                  />
                </div>
              ) : (
                <>
                  <section
                    aria-label={t('performance.summary', { defaultValue: 'Summary' })}
                    // Same ladder as the Overview's KPI row — the six-up jump straight
                    // from two columns left mid widths with tiles too narrow to name.
                    className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    <Tile
                      icon={<InboxIcon size={17} />}
                      label={t('performance.chats', { defaultValue: 'Chats' })}
                      value={String(summary.chats)}
                    />
                    <Tile
                      icon={<BellIcon size={17} />}
                      chip={summary.unanswered > 0 ? 'destructive' : 'neutral'}
                      label={t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                      value={String(summary.unanswered)}
                      tone={summary.unanswered > 0 ? 'bad' : 'plain'}
                    />
                    <Tile
                      icon={<ZapIcon size={17} />}
                      chip={
                        summary.metPct == null
                          ? 'neutral'
                          : summary.metPct >= 80
                            ? 'success'
                            : 'destructive'
                      }
                      label={t('performance.metPct', { defaultValue: 'Answered in time' })}
                      value={summary.metPct == null ? '—' : `${summary.metPct}%`}
                      hint={
                        summary.metPct == null
                          ? undefined
                          : t('performance.withinMinutes', {
                              defaultValue: 'Within {{n}} min',
                              n: targetMin,
                            })
                      }
                      tone={
                        summary.metPct == null ? 'plain' : summary.metPct >= 80 ? 'good' : 'bad'
                      }
                      visual={
                        summary.metPct == null ? undefined : (
                          // The board's ring accent — the same figure drawn as an arc.
                          <ProgressRing
                            value={summary.metPct}
                            size={48}
                            stroke={5}
                            tone={summary.metPct >= 80 ? 'success' : 'destructive'}
                            label={`${summary.metPct}%`}
                          />
                        )
                      }
                    />
                    {/* Each average names the population it was taken over.
                    They are DISJOINT — first response averages the answered
                    chats, time to solve averages the solved ones — so without
                    the denominators the pair reads as a contradiction: a
                    17-second solve beside a 5-hour first response looks like
                    chats being solved before anyone replies, when it is simply
                    two different handfuls of chats. */}
                    <Tile
                      icon={<ClockIcon size={17} />}
                      chip="sky"
                      label={t('performance.avgFirst', { defaultValue: 'First response' })}
                      value={formatDuration(summary.avgFirstResponseSec) ?? '—'}
                      hint={t('performance.avgOverAnswered', {
                        defaultValue: 'average over {{n}} answered',
                        n: summary.answered,
                      })}
                    />
                    <Tile
                      icon={<ChartIcon size={17} />}
                      chip="violet"
                      label={t('performance.avgSolve', { defaultValue: 'Time to solve' })}
                      value={formatDuration(summary.avgTimeToSolveSec) ?? '—'}
                      hint={t('performance.avgOverSolved', {
                        defaultValue: 'average over {{n}} solved',
                        n: summary.solved,
                      })}
                    />
                    <Tile
                      icon={<UsersIcon size={17} />}
                      chip={summary.commonChats > 0 ? 'success' : 'neutral'}
                      label={t('performance.commonChats', { defaultValue: 'Common chats taken' })}
                      value={String(summary.commonChats)}
                      tone={summary.commonChats > 0 ? 'good' : 'plain'}
                    />
                  </section>

                  {/* Chats an AGENT started (owner, 2026-10-07): first response is
                  not a fair measure for them, and time to solve depends on when
                  the customer answers — so: did the customer answer, how fast,
                  and how long the chat took once they did. */}
                  {outreach.started > 0 && (
                    <section
                      aria-label={t('performance.outreachTitle', {
                        defaultValue: 'Chats started by an agent',
                      })}
                      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
                    >
                      <Tile
                        label={t('performance.outreachStarted', {
                          defaultValue: 'Started by agent',
                        })}
                        value={String(outreach.started)}
                      />
                      <Tile
                        label={t('performance.outreachReplied', {
                          defaultValue: 'Customer replied',
                        })}
                        value={outreach.replyRatePct == null ? '—' : `${outreach.replyRatePct}%`}
                        hint={t('performance.outreachRepliedHint', {
                          defaultValue: '{{n}} of {{total}}',
                          n: outreach.customerReplied,
                          total: outreach.started,
                        })}
                      />
                      <Tile
                        label={t('performance.outreachReplyTime', {
                          defaultValue: 'Customer reply time',
                        })}
                        value={formatDuration(outreach.medianCustomerReplySec) ?? '—'}
                        hint={t('performance.median', { defaultValue: 'median' })}
                      />
                      <Tile
                        label={t('performance.outreachHandling', {
                          defaultValue: 'Solved after customer replied',
                        })}
                        value={formatDuration(outreach.medianHandlingSec) ?? '—'}
                        hint={t('performance.outreachHandlingHint', {
                          defaultValue: 'median · {{n}} closed without a reply',
                          n: outreach.closedWithoutReply,
                        })}
                      />
                    </section>
                  )}

                  {/* THE TWO PER-DAY CHARTS COME FIRST (owner, 2026-09-16).
                  Shape before attribution: "how busy was it, and were we
                  keeping up" is the question a reviewer opens this page with,
                  and it is answerable for the whole team. The per-agent
                  breakdown below answers "who", which only makes sense once
                  you know there was something to hand out. */}
                  <section className="grid gap-4 lg:grid-cols-2">
                    <Card
                      title={t('performance.perDayTitle', { defaultValue: 'Chats per day' })}
                      help={t('performance.perDayHelp', { defaultValue: 'How busy each day was' })}
                    >
                      <TrendChart
                        points={trend}
                        series={volumeSeries}
                        format={countFmt}
                        emptyLabel={nothingToChart}
                      />
                    </Card>
                    <Card
                      title={t('performance.speedPerDayTitle', {
                        defaultValue: 'Response times per day',
                      })}
                      help={t('performance.speedPerDayHelp', {
                        defaultValue: 'A gap is a day nothing was measurable',
                      })}
                    >
                      <TrendChart
                        points={trend}
                        series={timeSeries}
                        format={durFmt}
                        emptyLabel={nothingMeasured}
                      />
                    </Card>
                  </section>

                  {!filters.agentId && (
                    <section className="grid gap-4 lg:grid-cols-2">
                      <Card
                        // "Who handled" was a promise the chart could not keep:
                        // its biggest bar is routinely "Unassigned", which is
                        // nobody handling anything. The title now says what the
                        // bars actually measure, and the help line names the
                        // unassigned row for what it is — a backlog, not a person.
                        title={t('performance.whoTitle', { defaultValue: 'Where the chats sat' })}
                        help={t('performance.whoHelp', {
                          defaultValue:
                            'Chats assigned in this range. “Unassigned” is work nobody picked up — it is counted, not hidden.',
                        })}
                      >
                        <HBarChart
                          rows={compare.map((r) => ({ label: r.label, values: r.values }))}
                          series={volumeSeries}
                          format={countFmt}
                          emptyLabel={nothingToChart}
                        />
                      </Card>
                      <Card
                        /* "General chats answered" (owner, 2026-09-16). The old
                       title described the mechanism — picked up FOR THE TEAM —
                       which only makes sense if you already know how the
                       routing ladder releases a chat to everybody. The general
                       queue is what agents call it, so the chart is named after
                       the thing rather than the plumbing. */
                        title={t('performance.commonTitle', {
                          defaultValue: 'General chats answered',
                        })}
                        help={t('performance.commonHelp', {
                          defaultValue:
                            'Chats that reached the general queue and this agent answered',
                        })}
                      >
                        <HBarChart
                          rows={compare.map((r) => ({ label: r.label, values: r.values }))}
                          series={commonSeries}
                          format={countFmt}
                          emptyLabel={nothingToChart}
                        />
                      </Card>
                      <Card
                        title={t('performance.fastTitle', {
                          defaultValue: 'How fast they replied',
                        })}
                        help={t('performance.fastHelp', {
                          defaultValue: 'Averages per agent — shorter is better',
                        })}
                        // Full row: three cards on a two-column grid left a dead cell
                        // beside this one, and its two series per agent want the width.
                        className="lg:col-span-2"
                      >
                        <HBarChart
                          rows={compare.map((r) => ({
                            label: r.label,
                            note: r.note,
                            values: r.values,
                          }))}
                          series={timeSeries}
                          format={durFmt}
                          emptyLabel={nothingMeasured}
                        />
                      </Card>
                    </section>
                  )}

                  {/* The numbers behind the charts. No row opens anything — this page
              reviews the team, it does not work the queue. */}
                  <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in">
                    <header className="flex items-baseline justify-between gap-3  px-5 py-4">
                      <div>
                        <h2 className="text-sm font-semibold tracking-tight text-foreground">
                          {t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
                        </h2>
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          {t('performance.summaryHint', {
                            defaultValue: 'Every agent with chats in this range, busiest first.',
                          })}
                        </p>
                      </div>
                      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                        {t('performance.chatsCount', {
                          defaultValue: '{{n}} chats',
                          n: rows.reduce((sum, r) => sum + r.chats, 0),
                        })}
                      </span>
                    </header>
                    <div className="overflow-x-auto">
                      <table
                        className="w-full min-w-max text-sm"
                        aria-label={t('performance.summaryTable', {
                          defaultValue: 'Totals per agent',
                        })}
                      >
                        <thead>
                          <tr className="text-xs text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.07)]">
                            <th className="h-11 px-5 text-start font-semibold">
                              {t('performance.agent', { defaultValue: 'Agent' })}
                            </th>
                            <th className="h-11 px-5 text-start font-semibold">
                              {t('performance.chats', { defaultValue: 'Chats' })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.commonChats', { defaultValue: 'Common chats taken' })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.avgFirstCol', { defaultValue: 'First response' })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.solved', { defaultValue: 'Solved' })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.avgSolveCol', {
                                defaultValue: 'Time to solve (avg)',
                              })}
                            </th>
                            <th className="h-11 px-5 text-end font-semibold">
                              {t('performance.csat', { defaultValue: 'Customer rating' })}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y-0">
                          {rows.map((r) => (
                            <tr
                              key={r.agentId ?? 'unassigned'}
                              className="transition-colors duration-fast hover:bg-primary/[0.06]"
                            >
                              <td className="px-5 py-3">
                                <span className="flex items-center gap-2.5">
                                  <Avatar name={r.agentName} size="sm" />
                                  <span className="truncate font-medium text-foreground">
                                    {r.agentName}
                                  </span>
                                </span>
                              </td>
                              {/* Chats read as a share of the busiest agent, so the
                              workload spread is visible without the division. */}
                              <td className="px-5 py-3">
                                <span className="flex items-center gap-2.5">
                                  <span className="w-6 text-end text-sm font-bold tabular-nums text-foreground">
                                    {r.chats}
                                  </span>
                                  <MeterBar
                                    value={
                                      (r.chats / Math.max(1, ...rows.map((x) => x.chats))) * 100
                                    }
                                    tone="sky"
                                    className="w-20"
                                  />
                                </span>
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums">
                                {r.unanswered > 0 ? (
                                  <Pill tone="destructive" size="sm">
                                    {r.unanswered}
                                  </Pill>
                                ) : (
                                  <span className="text-muted-foreground">0</span>
                                )}
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums">
                                {r.commonChats > 0 ? (
                                  <Pill tone="success" size="sm">
                                    {r.commonChats}
                                  </Pill>
                                ) : (
                                  <span className="text-muted-foreground">0</span>
                                )}
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums text-foreground">
                                {formatDuration(r.avgFirstResponseSec) ?? dash}
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums text-foreground">
                                {r.solved}
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums text-muted-foreground">
                                {formatDuration(r.avgTimeToSolveSec) ?? dash}
                              </td>
                              <td className="px-5 py-3 text-end tabular-nums">
                                {(() => {
                                  const c = csatByAgent.get(r.agentId ?? '');
                                  if (!c)
                                    return <span className="text-muted-foreground">{dash}</span>;
                                  return (
                                    <span
                                      className={cn(
                                        'font-semibold',
                                        c.avg >= 4 ? 'text-success' : 'text-foreground',
                                      )}
                                      title={t('performance.csatCount', {
                                        defaultValue: '{{n}} rated',
                                        n: c.n,
                                      })}
                                    >
                                      {c.avg.toFixed(1)}
                                    </span>
                                  );
                                })()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  {/* Chat by chat: its own switch (owner, 2026-10-15: not for the CEO). */}
                  {canSeeChats && (
                    <>
                      {/* Chat by chat — the six columns the owner asked for. A row
                  opens the conversation in the agent portal, which is where a
                  supervisor goes to see what was actually said. */}
                      <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in">
                        <header className="flex items-baseline justify-between gap-3  px-5 py-4">
                          <h2 className="text-sm font-semibold tracking-tight text-foreground">
                            {t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                          </h2>
                          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                            {breakdown.length === breakdownAll.length
                              ? breakdown.length
                              : `${breakdown.length} / ${breakdownAll.length}`}
                          </span>
                        </header>
                        <div className="max-h-[32rem] overflow-auto">
                          <table
                            className="w-full min-w-max text-sm"
                            aria-label={t('performance.breakdownTitle', {
                              defaultValue: 'Chat by chat',
                            })}
                          >
                            <thead className="sticky top-0 z-10 bg-card">
                              <tr className="text-xs text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.07)]">
                                <th className="h-11 px-5 text-start font-semibold">
                                  {t('performance.subject', { defaultValue: 'Ticket / chat' })}
                                </th>
                                <th className="h-11 px-5 text-start font-semibold">
                                  {t('performance.customer', { defaultValue: 'Customer' })}
                                </th>
                                <th className="h-11 px-5 text-start font-semibold">
                                  {t('performance.agent', { defaultValue: 'Agent' })}
                                </th>
                                <th className="h-11 px-5 text-start font-semibold">
                                  {t('performance.started', { defaultValue: 'Started' })}
                                </th>
                                <th className="h-11 px-5 text-start font-semibold">
                                  {t('performance.startedBy', { defaultValue: 'Started by' })}
                                </th>
                                <th className="h-11 px-5 text-end font-semibold">
                                  {t('performance.firstResponse', {
                                    defaultValue: 'First response',
                                  })}
                                </th>
                                <th className="h-11 px-5 text-end font-semibold">
                                  {t('performance.timeToSolve', { defaultValue: 'Time to solve' })}
                                </th>
                                <th className="h-11 px-5 text-end font-semibold">
                                  {t('performance.csat', { defaultValue: 'Customer rating' })}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y-0">
                              {breakdown.length === 0 && <NoMatchRow colSpan={8} search={search} />}
                              {breakdown.map(({ chat, first, solve }) => (
                                <tr
                                  key={chat.conversationId}
                                  className="transition-colors duration-fast hover:bg-primary/[0.06]"
                                >
                                  <td className="max-w-[20rem] px-5 py-3">
                                    <span
                                      className="block truncate font-medium text-foreground"
                                      title={chat.subject ?? ''}
                                    >
                                      {chat.subject ??
                                        t('performance.noSubject', {
                                          defaultValue: 'Chat (no ticket)',
                                        })}
                                    </span>
                                    {/* The ids a search finds it by (owner, 2026-10-12). */}
                                    {(chat.ticketId || chat.orderId) && (
                                      <span className="font-mono text-2xs text-muted-foreground">
                                        {[
                                          chat.ticketId ? `ID ${chat.ticketId}` : null,
                                          chat.orderId ? `#${chat.orderId}` : null,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-5 py-3 text-muted-foreground">
                                    <span className="block max-w-[12rem] truncate">
                                      {chat.customer ??
                                        t('performance.unknownCustomer', {
                                          defaultValue: 'Customer',
                                        })}
                                    </span>
                                  </td>
                                  <td className="px-5 py-3">
                                    <span className="flex items-center gap-2">
                                      <Avatar name={chat.agentName} size="sm" />
                                      <span className="truncate text-foreground">
                                        {chat.agentName}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="px-5 py-3 tabular-nums text-muted-foreground">
                                    {chat.startedAt ? formatDateTime(chat.startedAt) : dash}
                                  </td>
                                  <td className="px-5 py-3 text-muted-foreground">
                                    {chat.initiatedBy === 'agent'
                                      ? t('performance.byAgent', { defaultValue: 'Agent' })
                                      : t('performance.byCustomer', { defaultValue: 'Customer' })}
                                  </td>
                                  {/* "No reply" rather than a dash: the worst outcome
                              on the page must not read as missing data. */}
                                  <td
                                    className={cn(
                                      'px-5 py-3 text-end tabular-nums',
                                      chat.passedOn || awaitingCustomer(chat)
                                        ? 'text-muted-foreground'
                                        : first == null
                                          ? 'font-semibold text-destructive'
                                          : 'text-foreground',
                                    )}
                                  >
                                    {awaitingCustomer(chat)
                                      ? t('performance.customerNotReplied', {
                                          defaultValue: 'Customer hasn’t replied',
                                        })
                                      : first == null
                                        ? t('performance.noReplyYet', {
                                            defaultValue: 'No reply yet',
                                          })
                                        : formatDuration(first)}
                                    {/* Why this row is not counted against the target,
                                    as in the agent portal (owner, 2026-10-13). */}
                                    {chat.passedOn && (
                                      <span className="ms-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {t('performance.commonChat', { defaultValue: 'common' })}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-5 py-3 text-end tabular-nums text-muted-foreground">
                                    {solve != null
                                      ? formatDuration(solve)
                                      : chat.solvedAt
                                        ? awaitingCustomer(chat)
                                          ? t('performance.closedNoReply', {
                                              defaultValue: 'Closed — no customer reply',
                                            })
                                          : t('performance.closed', { defaultValue: 'Closed' })
                                        : awaitingCustomer(chat)
                                          ? t('performance.waitingCustomer', {
                                              defaultValue: 'Waiting for customer',
                                            })
                                          : dash}
                                  </td>
                                  {/* This chat's own rating, as in the agent portal;
                                  empty when the customer did not rate (owner,
                                  2026-10-13). */}
                                  <td className="px-5 py-3 text-end tabular-nums text-foreground">
                                    {(() => {
                                      const score = csat.data?.get(chat.conversationId);
                                      return typeof score === 'number' ? `${score}/5` : '';
                                    })()}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    </>
                  )}
                </>
              )}

              <p className="px-1 pb-2 text-2xs leading-relaxed text-muted-foreground">
                {t('performance.commonBasis', {
                  defaultValue:
                    'A chat the system had to pass on is left out of the response-time figures — it carries the wait the earlier agents caused — and counted here instead, for whoever picked it up.',
                })}{' '}
                {t('performance.basis', {
                  defaultValue:
                    'First response is measured from the customer’s first message to the first agent reply; internal notes do not count as a reply. Chats nobody has answered are counted under “No reply yet” and left out of the averages, but they still count against “Answered in time”.',
                })}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A filter control with its name above it. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}

/** A chart in a card, with the question it answers written above it. */
function Card({
  title,
  help,
  className,
  children,
}: {
  title: string;
  help: string;
  className?: string;
  children: ReactNode;
}) {
  // The frosted section of the Rapport skin: the question as a heading, the
  // explanation under it, and no hue bar beside it (side stripes are banned).
  return (
    <section
      className={cn('rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]', className)}
    >
      <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{help}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
