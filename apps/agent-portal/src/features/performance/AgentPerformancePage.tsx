import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { normalizePhone } from '@yiji/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { canReadConversation } from '../tickets/api.js';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  cn,
  DateField,
  EmptyState,
  formatDateTime,
  HBarChart,
  InboxIcon,
  Input,
  MeterBar,
  pageCountOf,
  Pill,
  SearchIcon,
  SectionCard,
  SelectMenu,
  Skeleton,
  TablePager,
  toast,
  Toolbar,
  ToolbarSpacer,
  TrendChart,
  CheckCircleIcon,
  ClockIcon,
  SparkleIcon,
  UsersIcon,
  ZapIcon,
  type ChartSeries,
} from '@yiji/ui';
import {
  agentPerformance,
  comparisonRows,
  dailyTrend,
  firstResponseSec,
  formatDuration,
  performanceSummary,
  timeToSolveSec,
  agentInitiatedSummary,
  awaitingCustomer,
  defaultPerformanceRange,
  matchesSearch,
} from '@yiji/reports';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useSlaHours } from '../../lib/sla-hours.js';
import { useAgents } from '../inbox/api.js';
import { useVendorDirectory } from '../../lib/vendors.js';
import {
  useChatTimings,
  useCsatByConversation,
  type ChatTimingRow,
  type PerformanceFilters,
} from './api.js';
import { ViewSwitch } from '../../components/ViewSwitch.js';
import {
  PERF_BODY_ROW,
  PERF_HEAD_ROW,
  PERF_TABLE_CARD,
  PERF_TD,
  PERF_TH,
  Tile,
  TileGrid,
} from './Tile.js';
import { CouponsTab, TicketsTab } from './WorkTabs.js';

/**
 * Agent performance: how much work arrived, how fast it was answered, and every
 * chat behind those numbers.
 *
 * Four things, in the order they get asked:
 *
 *   1. the headline numbers, as plain tiles;
 *   2. who handled what, and how fast;
 *   3. the shape of the period, day by day;
 *   4. the chats themselves, so any number can be followed to its cause.
 *
 * An earlier version carried a totals table repeating the comparison chart and
 * a met/missed bar repeating a tile, behind a met-vs-missed toggle that split
 * every chart in two. All gone: three ways to read one number is not
 * thoroughness, it is three places for a reader to wonder which is right.
 *
 * CHARTS ARE GROUPED BY UNIT, never mixed. A count of chats and an average in
 * seconds on one shared axis would draw "9 chats" as an invisible sliver beside
 * "4m 12s", which is not a comparison — it is a chart that lies about which
 * number is bigger. So volume and durations sit side by side, each with its own
 * scale and its own formatter.
 *
 * Volume is charted at all because on a quiet range, or one where chats went
 * unanswered, every response-time chart is legitimately empty — and a page of
 * empty charts reads as broken software rather than as a quiet week. Chats
 * handled is always countable, so there is always one honest line, and the
 * missing timings stay visibly missing.
 */
const DEFAULT_TARGET_MIN = 5;

const countFmt = (v: number) => String(v);

/**
 * THREE SUB-PAGES (owner, 2026-10-07): Chats, Tickets and Coupons. A ticket
 * raised from the Add-ticket page or a coupon sent for approval never touched
 * a chat, so the chats-only page had nowhere to show them.
 */
const TABS = ['chats', 'tickets', 'coupons'] as const;
type PerformanceTab = (typeof TABS)[number];
const isTab = (v: unknown): v is PerformanceTab =>
  typeof v === 'string' && (TABS as readonly string[]).includes(v);

interface SavedView {
  filters?: PerformanceFilters;
  targetMin?: number;
  tab?: PerformanceTab;
  search?: string;
}

/* The opening range now lives in @yiji/reports, shared with the admin console
   (owner, 2026-10-12); re-exported so existing callers keep their import. */
export { defaultPerformanceRange };

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  /*
   * A row opens its chat (owner, 2026-10-11). Every agent now sees every
   * agent's rows here, but the inbox keeps its rules: a live chat held by
   * someone else would open blank, so it says why instead.
   */
  const openChat = async (conversationId: string) => {
    const ok = await queryClient
      .fetchQuery({
        queryKey: ['can-read-conversation', conversationId],
        staleTime: 60_000,
        queryFn: () => canReadConversation(conversationId),
      })
      .catch(() => true);
    if (ok) navigate(`/?conv=${encodeURIComponent(conversationId)}`);
    else
      toast(
        t('tickets.conversationNotVisible', { defaultValue: 'chat assigned to another agent' }),
      );
  };
  const { user } = useAuth();
  const agents = useAgents();

  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) {
      m.set(a.id, a.first_name?.trim() || a.email?.trim() || a.id);
    }
    return m;
  }, [agents.data]);

  /*
   * DEFAULTS TO THE PERSON LOOKING.
   *
   * This page opened on "All agents", so an agent's own numbers were three
   * clicks away and the first thing they saw was the whole team's — which is
   * both the wrong question for them and a league table nobody asked to be
   * shown. It now opens on their own row and the picker still offers everyone,
   * so comparing is a choice rather than the default.
   *
   * Lazy initial state, not an effect: setting it afterwards would render the
   * team view for a frame and fire a second query for data nobody asked for.
   */
  /*
   * THE FILTERS SURVIVE LEAVING THE PAGE (owner, 2026-10-07): coming back from
   * another page used to reset the agent and the date range to "my own, all
   * time". Kept per TAB (sessionStorage — sessions here are per tab) and per
   * signed-in user, so two agents sharing a machine never inherit each
   * other's view. Storage can be unavailable; then it simply starts fresh.
   */
  const filtersKey = `agent-performance:${user?.id ?? 'anon'}`;
  const saved = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(filtersKey);
      return raw ? (JSON.parse(raw) as SavedView) : null;
    } catch {
      return null;
    }
    // Read once per user; later writes are this page's own.
  }, [filtersKey]);
  /*
   * OPENS ON YESTERDAY'S BUSINESS DAY THROUGH TODAY (owner, 2026-10-11) - the
   * shift that just ended plus the one running now. Business days turn at
   * 08:00 Riyadh. Once the agent changes it, their choice is kept (above)
   * until they sign out; signing out clears it, so the next sign-in opens on
   * this default again (AuthContext.logout).
   */
  const [filters, setFilters] = useState<PerformanceFilters>(
    () =>
      saved?.filters ?? {
        ...(user?.id ? { agentId: user.id } : {}),
        ...defaultPerformanceRange(),
      },
  );
  /* THE RESPONSE TARGET IS FIXED (owner, 2026-10-25: "remove Target from the
     filters"). "Answered in time" is scored against the default and says so
     on its card; a target remembered from before is no longer read. */
  const targetMin = DEFAULT_TARGET_MIN;
  /*
   * THE TAB LIVES IN THE URL (`?tab=tickets`), so a link to one sub-page opens
   * that sub-page; with no `?tab=` the tab this agent last had open in this
   * browser tab is restored (owner, 2026-10-07).
   */
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab');
  const tab: PerformanceTab = isTab(urlTab) ? urlTab : isTab(saved?.tab) ? saved.tab : 'chats';
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
   * SEARCH (owner, 2026-10-07): "search by customer number, ticket id, or
   * ticket title — especially for the Chat by chat table". Applies to the
   * ACTIVE tab's table; the headline numbers keep counting the whole range.
   * Lightly debounced so a long number does not re-filter on every digit.
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
      sessionStorage.setItem(filtersKey, JSON.stringify(view));
    } catch {
      /* private mode or full storage: the page still works, it just forgets */
    }
  }, [filtersKey, filters, tab, search]);

  /*
   * THE VENDOR FILTER (MV-7): offered, and applied, only with 2+ active
   * vendors. `scoped` is what every read on the page (chats, tickets, coupons,
   * KPIs) is asked with: with one vendor it carries no `vendor` key at all, so
   * each query is exactly what it was. A remembered choice whose vendor is gone
   * (or that is the last one left) stops applying instead of emptying the page.
   */
  const vendorDir = useVendorDirectory();
  const vendorFilter =
    vendorDir.show && filters.vendor && vendorDir.options.some((v) => v.id === filters.vendor)
      ? filters.vendor
      : undefined;
  const scoped = useMemo<PerformanceFilters>(() => {
    const out: PerformanceFilters = {};
    if (filters.from !== undefined) out.from = filters.from;
    if (filters.to !== undefined) out.to = filters.to;
    if (filters.agentId !== undefined) out.agentId = filters.agentId;
    if (vendorFilter) out.vendor = vendorFilter;
    return out;
  }, [filters.from, filters.to, filters.agentId, vendorFilter]);

  const timings = useChatTimings(scoped);
  /* WORKING HOURS (owner, 2026-10-08): every duration on this page counts only
     the chat SLA policy's working hours, as the SLA engine does. Stamped on each
     chat so every shared function below reads the same clock. */
  const slaHours = useSlaHours();
  const chatHours = slaHours.data?.chat ?? null;
  /**
   * Names are attached HERE, not inside the query: the two come from different
   * requests, and a query cached under the filters alone will hold rows
   * resolved against an empty name map — which is how this page once rendered
   * agent uuids where names belong.
   */
  const chats = useMemo<ChatTimingRow[]>(
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
  const timeSeries: ChartSeries[] = [
    {
      key: 'first',
      label: t('performance.firstResponse', { defaultValue: 'First response' }),
      tone: 'primary',
    },
    {
      key: 'solve',
      label: t('performance.timeToSolve', { defaultValue: 'Time to solve' }),
      tone: 'violet',
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

  /**
   * NEWEST FIRST (owner, 2026-09-16).
   *
   * This used to lead with the SLOWEST chats, on the reasoning that the worst
   * response times are what a reviewer should look at. That is a good argument
   * for a report somebody reads once a month, and the wrong one for a table an
   * agent opens to find the chat they just handled: ranking by a measure means
   * a chat's position moves as its timings change, so the row you are looking
   * for is wherever it happens to have landed. A date sort puts it where you
   * expect it every time, and the slow ones are still visible — the response
   * columns say so on every row.
   *
   * Chats with no start time sink rather than leading. They are missing data,
   * not recent work, and giving them the top of a newest-first table would
   * claim they are the latest thing that happened.
   */
  const breakdownAll = useMemo(
    () =>
      chats
        .map((c) => ({ chat: c, first: firstResponseSec(c), solve: timeToSolveSec(c) }))
        .sort((a, b) => {
          const at = a.chat.startedAt ? Date.parse(a.chat.startedAt) : null;
          const bt = b.chat.startedAt ? Date.parse(b.chat.startedAt) : null;
          if (at == null && bt == null) return 0;
          if (at == null) return 1;
          if (bt == null) return -1;
          return bt - at;
        }),
    [chats],
  );
  /* The search narrows the TABLE only, never the tiles above it. */
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

  /* THE PAGER (owner, 2026-10-25: footer and pager inside the card). The
     page is clamped, so narrowing the search never strands it past the end. */
  const [breakdownPageNo, setBreakdownPageNo] = useState(1);
  const [breakdownPageSize, setBreakdownPageSize] = useState(25);
  const breakdownCurrent = Math.min(
    Math.max(1, breakdownPageNo),
    pageCountOf(breakdown.length, breakdownPageSize),
  );
  const breakdownPage = breakdown.slice(
    (breakdownCurrent - 1) * breakdownPageSize,
    breakdownCurrent * breakdownPageSize,
  );

  /** Per-agent totals — the same shared rollup the admin console reports. */
  const chatIds = useMemo(() => chats.map((c) => c.conversationId), [chats]);
  const csat = useCsatByConversation(scoped, chatIds);
  const totals = useMemo(() => agentPerformance(chats), [chats]);
  /* CSAT joined onto the same chats the rest of the page measures, so the
     rating column can never describe a different population than the timings
     beside it. `null` where nobody rated — an unrated agent is not a zero. */
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

  /** Team-wide rating for the tile. */
  const csatOverall = useMemo(() => {
    let sum = 0;
    let n = 0;
    for (const v of csatByAgent.values()) {
      sum += v.avg * v.n;
      n += v.n;
    }
    return n ? { avg: sum / n, n } : null;
  }, [csatByAgent]);

  const oneAgent = !!filters.agentId;
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
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('performance.title', { defaultValue: 'Agent performance' })}
        </h1>
        <ToolbarSpacer />
        {/* With the filters, at the top (owner, 2026-10-07). Sized on the
            wrapper for the same reason as the date fields below. */}
        <div className="relative w-[14rem] shrink-0">
          <SearchIcon
            size={14}
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="h-8 ps-8"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            aria-label={t('performance.search', { defaultValue: 'Search' })}
            placeholder={t('performance.searchPlaceholder', {
              defaultValue: 'Customer number, ticket ID or title…',
            })}
          />
        </div>
        <SelectMenu
          size="sm"
          className="w-[11rem] shrink-0"
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
        {/* Whose work (MV-7) — only with 2+ active vendors. */}
        {vendorDir.show && (
          <SelectMenu
            size="sm"
            className="w-[10rem] shrink-0"
            value={vendorFilter ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, vendor: v || undefined }))}
            aria-label={t('performance.vendor', { defaultValue: 'Vendor' })}
            options={[
              { value: '', label: t('performance.allVendors', { defaultValue: 'All vendors' }) },
              ...vendorDir.options.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        )}
        {/* Widths go on the WRAPPER, not the input: Input carries `w-full` in
            its base classes and `cn` is a plain joiner, not tailwind-merge, so
            a `w-…` passed through className is a coin toss against it. Sizing
            the box and letting the field fill it is the only stable version —
            without this the date fields ate the toolbar. */}
        <div className="w-[8.75rem] shrink-0">
          <DateField
            size="sm"
            aria-label={t('performance.from', { defaultValue: 'From' })}
            value={filters.from ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, from: v }))}
          />
        </div>
        <div className="w-[8.75rem] shrink-0">
          <DateField
            size="sm"
            aria-label={t('performance.to', { defaultValue: 'To' })}
            value={filters.to ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, to: v }))}
          />
        </div>
      </Toolbar>

      <div className="agent-gutter min-h-0 flex-1 overflow-auto pb-8 pt-2">
        <div className="space-y-4">
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
            <TicketsTab filters={scoped} search={search} agentNames={agentNames} />
          ) : tab === 'coupons' ? (
            <CouponsTab filters={scoped} search={search} />
          ) : (
            <>
              {timings.isLoading || agents.isLoading || slaHours.isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-[5.5rem] w-full rounded-2xl" />
                  <Skeleton className="h-56 w-full rounded-2xl" />
                  <Skeleton className="h-56 w-full rounded-2xl" />
                </div>
              ) : chats.length === 0 ? (
                // Composed empty state on the card surface — a lone sentence in a
                // 1152px column reads as a rendering gap, not as a quiet range.
                <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
                  <EmptyState
                    icon={<InboxIcon size={24} />}
                    title={t('performance.empty', {
                      defaultValue: 'No chats match these filters.',
                    })}
                  />
                </div>
              ) : (
                <>
                  {/* 1 — the headline. Five numbers, no chrome around them.
                  Named, so it is a landmark a screen-reader user can jump to
                  rather than five loose numbers before the charts. */}
                  <TileGrid count={7} label={t('performance.summary', { defaultValue: 'Summary' })}>
                    <Tile
                      label={t('performance.chats', { defaultValue: 'Chats' })}
                      value={String(summary.chats)}
                      icon={<InboxIcon size={18} />}
                      hue="blue"
                      hint={t('performance.answeredCount', {
                        defaultValue: '{{n}} answered',
                        n: summary.answered,
                      })}
                    />
                    <Tile
                      label={t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                      value={String(summary.unanswered)}
                      tone={summary.unanswered > 0 ? 'bad' : 'plain'}
                      icon={<ClockIcon size={18} />}
                      hue="amber"
                      hint={
                        summary.unanswered > 0
                          ? t('performance.noReplyHint', {
                              defaultValue: 'Waiting for a first reply',
                            })
                          : t('performance.allAnswered', { defaultValue: 'Every chat answered' })
                      }
                    />
                    <Tile
                      label={t('performance.metPct', { defaultValue: 'Answered in time' })}
                      value={summary.metPct == null ? '—' : `${summary.metPct}%`}
                      tone={
                        summary.metPct == null ? 'plain' : summary.metPct >= 80 ? 'good' : 'bad'
                      }
                      icon={<CheckCircleIcon size={18} />}
                      hue="green"
                      hint={
                        summary.metPct == null
                          ? undefined
                          : t('performance.withinMinutes', {
                              defaultValue: 'Within {{n}} min',
                              n: targetMin,
                            })
                      }
                      meter={
                        summary.metPct == null ? undefined : (
                          <MeterBar
                            value={summary.metPct}
                            tone={summary.metPct >= 80 ? 'success' : 'destructive'}
                          />
                        )
                      }
                    />
                    <Tile
                      label={t('performance.avgFirst', { defaultValue: 'First response' })}
                      value={formatDuration(summary.avgFirstResponseSec) ?? '—'}
                      icon={<ZapIcon size={18} />}
                      hue="violet"
                      hint={
                        summary.avgFirstResponseSec == null
                          ? undefined
                          : t('performance.avgMedian', {
                              defaultValue: 'average · median {{median}}',
                              median: formatDuration(summary.medianFirstResponseSec) ?? '—',
                            })
                      }
                    />
                    <Tile
                      label={t('performance.avgSolve', { defaultValue: 'Time to solve' })}
                      value={formatDuration(summary.avgTimeToSolveSec) ?? '—'}
                      icon={<ClockIcon size={18} />}
                      hue="blue"
                      hint={
                        summary.avgTimeToSolveSec == null
                          ? undefined
                          : t('performance.average', { defaultValue: 'average' })
                      }
                    />
                    {/* What the customer thought — the only measure here they do
                    not control by working faster. */}
                    <Tile
                      label={t('performance.csat', { defaultValue: 'Customer rating' })}
                      value={csatOverall ? `${csatOverall.avg.toFixed(1)}/5` : '—'}
                      tone={csatOverall == null ? 'plain' : csatOverall.avg >= 4 ? 'good' : 'bad'}
                      icon={<SparkleIcon size={18} />}
                      hue="amber"
                      hint={
                        csatOverall
                          ? t('performance.csatCount', {
                              defaultValue: '{{n}} rated',
                              n: csatOverall.n,
                            })
                          : undefined
                      }
                    />
                    {/* Picking up a chat nobody else answered is worth its own
                    number: it never shows in a response-time average, and it is
                    the one thing on this page a person can decide to do more
                    of. */}
                    <Tile
                      label={t('performance.commonChats', { defaultValue: 'Common chats taken' })}
                      value={String(summary.commonChats)}
                      tone={summary.commonChats > 0 ? 'good' : 'plain'}
                      icon={<UsersIcon size={18} />}
                      hue="green"
                      hint={t('performance.commonHint', { defaultValue: 'Picked up for the team' })}
                    />
                  </TileGrid>

                  {/* 1b — chats an AGENT started (owner, 2026-10-07). First
                  response is not a fair measure for them — the agent wrote
                  first — and time to solve depends on when the customer
                  answers, so they get their own numbers: did the customer
                  answer, how fast, and how long the chat took once they did. */}
                  {outreach.started > 0 && (
                    <TileGrid
                      count={4}
                      label={t('performance.outreachTitle', {
                        defaultValue: 'Chats started by an agent',
                      })}
                    >
                      <Tile
                        label={t('performance.outreachStarted', {
                          defaultValue: 'Started by agent',
                        })}
                        value={String(outreach.started)}
                        icon={<InboxIcon size={18} />}
                        hue="violet"
                        hint={t('performance.outreachTitle', {
                          defaultValue: 'Chats started by an agent',
                        })}
                      />
                      <Tile
                        label={t('performance.outreachReplied', {
                          defaultValue: 'Customer replied',
                        })}
                        value={outreach.replyRatePct == null ? '—' : `${outreach.replyRatePct}%`}
                        icon={<CheckCircleIcon size={18} />}
                        hue="green"
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
                        icon={<ZapIcon size={18} />}
                        hue="blue"
                        hint={
                          outreach.medianCustomerReplySec == null
                            ? undefined
                            : t('performance.median', { defaultValue: 'median' })
                        }
                      />
                      <Tile
                        label={t('performance.outreachHandling', {
                          defaultValue: 'Solved after customer replied',
                        })}
                        value={formatDuration(outreach.medianHandlingSec) ?? '—'}
                        icon={<ClockIcon size={18} />}
                        hue="amber"
                        hint={t('performance.outreachHandlingHint', {
                          defaultValue: 'median · {{n}} closed without a reply',
                          n: outreach.closedWithoutReply,
                        })}
                      />
                    </TileGrid>
                  )}

                  {/* 2 — agent by agent. Hidden for a single agent: a bar chart of
                  one person against themselves compares nothing. */}
                  {!oneAgent && (
                    <section className="grid gap-4 lg:grid-cols-2">
                      <Card
                        title={t('performance.whoTitle', { defaultValue: 'Who handled the chats' })}
                        help={t('performance.whoHelp', {
                          defaultValue: 'Chats assigned in this range',
                        })}
                      >
                        <HBarChart
                          rows={compare.map((r) => ({
                            label: r.label,
                            highlight: r.agentId === user?.id,
                            values: r.values,
                          }))}
                          series={volumeSeries}
                          format={countFmt}
                          emptyLabel={nothingToChart}
                        />
                      </Card>
                      <Card
                        title={t('performance.commonTitle', {
                          defaultValue: 'Chats picked up for the team',
                        })}
                        help={t('performance.commonHelp', {
                          defaultValue: 'Chats answered after somebody else let them go',
                        })}
                      >
                        <HBarChart
                          rows={compare.map((r) => ({
                            label: r.label,
                            highlight: r.agentId === user?.id,
                            values: r.values,
                          }))}
                          series={commonSeries}
                          format={countFmt}
                          emptyLabel={nothingToChart}
                        />
                      </Card>
                      {/* Two series per agent — the widest chart of the three, and
                      the odd one out of a two-column grid. Spanning it stops the
                      row from carrying a dead empty cell beside it. */}
                      <Card
                        className="lg:col-span-2"
                        title={t('performance.fastTitle', {
                          defaultValue: 'How fast they replied',
                        })}
                        help={t('performance.fastHelp', {
                          defaultValue: 'Averages per agent — shorter is better',
                        })}
                      >
                        <HBarChart
                          rows={compare.map((r) => ({
                            label: r.label,
                            note: r.note,
                            highlight: r.agentId === user?.id,
                            values: r.values,
                          }))}
                          series={timeSeries}
                          format={durFmt}
                          emptyLabel={nothingMeasured}
                        />
                      </Card>
                    </section>
                  )}

                  {/* 3 — the shape of the period. */}
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

                  {/* 4 — the chats themselves. An average nobody can drill into is
                  an accusation. */}
                  {/* Totals per agent — the shape the owner liked in the admin
                  console: an avatar beside the name, and the chat count drawn
                  as a share of the busiest agent so the workload spread is
                  visible without doing the division. Hidden when the page is
                  already filtered to one agent, where a one-row table of
                  totals says nothing the tiles above have not. */}
                  {!oneAgent && totals.length > 1 && (
                    <section className={cn(PERF_TABLE_CARD, 'overflow-hidden')}>
                      <header className="flex items-baseline justify-between gap-3 px-5 py-4">
                        <h2 className="text-sm font-semibold tracking-tight text-foreground">
                          {t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
                        </h2>
                        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                          {t('performance.chatsCount', {
                            defaultValue: '{{n}} chats',
                            n: totals.reduce((sum, r) => sum + r.chats, 0),
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
                            <tr className={PERF_HEAD_ROW}>
                              <th className={PERF_TH}>
                                {t('performance.agent', { defaultValue: 'Agent' })}
                              </th>
                              <th className={PERF_TH}>
                                {t('performance.chats', { defaultValue: 'Chats' })}
                              </th>
                              <th className={cn(PERF_TH, 'text-end')}>
                                {t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                              </th>
                              <th className={cn(PERF_TH, 'text-end')}>
                                {t('performance.commonChats', {
                                  defaultValue: 'Common chats taken',
                                })}
                              </th>
                              <th className={cn(PERF_TH, 'text-end')}>
                                {t('performance.avgFirstCol', {
                                  defaultValue: 'First response (avg)',
                                })}
                              </th>
                              <th className={cn(PERF_TH, 'text-end')}>
                                {t('performance.avgSolveCol', {
                                  defaultValue: 'Time to solve (avg)',
                                })}
                              </th>
                              <th className={cn(PERF_TH, 'text-end')}>
                                {t('performance.csat', { defaultValue: 'Customer rating' })}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y-0">
                            {totals.map((r) => (
                              <tr
                                key={r.agentId ?? 'unassigned'}
                                className="border-t border-foreground/[0.06] transition-colors duration-fast hover:bg-primary/[0.05]"
                              >
                                <td className={PERF_TD}>
                                  <span className="flex items-center gap-2.5">
                                    <Avatar name={r.agentName} size="sm" />
                                    <span className="truncate font-medium text-foreground">
                                      {r.agentName}
                                    </span>
                                  </span>
                                </td>
                                <td className={PERF_TD}>
                                  <span className="flex items-center gap-2.5">
                                    <span className="w-6 text-end text-sm font-bold tabular-nums text-foreground">
                                      {r.chats}
                                    </span>
                                    <MeterBar
                                      value={
                                        (r.chats / Math.max(1, ...totals.map((x) => x.chats))) * 100
                                      }
                                      tone="sky"
                                      className="w-20"
                                    />
                                  </span>
                                </td>
                                <td className={cn(PERF_TD, 'text-end tabular-nums')}>
                                  {r.unanswered > 0 ? (
                                    <Pill tone="destructive" size="sm">
                                      {r.unanswered}
                                    </Pill>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </td>
                                <td className={cn(PERF_TD, 'text-end tabular-nums')}>
                                  {r.commonChats > 0 ? (
                                    <Pill tone="success" size="sm">
                                      {r.commonChats}
                                    </Pill>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </td>
                                <td
                                  className={cn(PERF_TD, 'text-end tabular-nums text-foreground')}
                                >
                                  {formatDuration(r.avgFirstResponseSec) ?? '—'}
                                </td>
                                <td
                                  className={cn(
                                    PERF_TD,
                                    'text-end tabular-nums text-muted-foreground',
                                  )}
                                >
                                  {formatDuration(r.avgTimeToSolveSec) ?? '—'}
                                </td>
                                <td className={cn(PERF_TD, 'text-end tabular-nums')}>
                                  {(() => {
                                    const c = csatByAgent.get(r.agentId ?? '');
                                    if (!c) return <span className="text-muted-foreground">—</span>;
                                    return (
                                      <span
                                        className={cn(
                                          'font-semibold',
                                          c.avg >= 4 ? 'text-success' : 'text-foreground',
                                        )}
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
                  )}

                  <section className={PERF_TABLE_CARD}>
                    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-4">
                      <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                        {t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                      </h2>
                      <span className="text-2xs text-muted-foreground">
                        {t('performance.breakdownHelp', {
                          defaultValue: 'Slowest first. Open one to see what happened.',
                        })}
                      </span>
                      <span className="ms-auto text-2xs tabular-nums text-muted-foreground">
                        {breakdown.length === breakdownAll.length
                          ? breakdown.length
                          : `${breakdown.length} / ${breakdownAll.length}`}
                      </span>
                    </header>
                    {/* No inner scroller (owner, 2026-10-25): the PAGE scrolls,
                        and the pager in the card's foot keeps a long range to
                        one screen of rows at a time. Sideways only, for a
                        narrow window. */}
                    <div className="overflow-x-auto">
                      <table
                        className="w-full text-sm"
                        aria-label={t('performance.breakdownTitle', {
                          defaultValue: 'Chat by chat',
                        })}
                      >
                        <thead>
                          <tr className={PERF_HEAD_ROW}>
                            <th className={PERF_TH}>
                              {t('performance.subject', { defaultValue: 'Ticket / chat' })}
                            </th>
                            <th className={PERF_TH}>
                              {t('performance.customer', { defaultValue: 'Customer' })}
                            </th>
                            {!oneAgent && (
                              <th className={PERF_TH}>
                                {t('performance.agent', { defaultValue: 'Agent' })}
                              </th>
                            )}
                            <th className={PERF_TH}>
                              {t('performance.started', { defaultValue: 'Started' })}
                            </th>
                            <th className={PERF_TH}>
                              {t('performance.startedBy', { defaultValue: 'Started by' })}
                            </th>
                            <th className={cn(PERF_TH, 'text-end')}>
                              {t('performance.firstResponse', { defaultValue: 'First response' })}
                            </th>
                            <th className={cn(PERF_TH, 'text-end')}>
                              {t('performance.timeToSolve', { defaultValue: 'Time to solve' })}
                            </th>
                            <th className={cn(PERF_TH, 'text-end')}>
                              {t('performance.csat', { defaultValue: 'Customer rating' })}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdown.length === 0 && (
                            <tr>
                              <td
                                colSpan={oneAgent ? 7 : 8}
                                className="px-5 py-10 text-center text-sm text-muted-foreground"
                              >
                                {t('performance.searchNoMatch', {
                                  defaultValue: 'Nothing matches “{{q}}”.',
                                  q: search.trim(),
                                })}
                              </td>
                            </tr>
                          )}
                          {breakdownPage.map(({ chat, first, solve }) => (
                            <tr
                              key={chat.conversationId}
                              onClick={() => void openChat(chat.conversationId)}
                              className={PERF_BODY_ROW}
                            >
                              <td className={cn(PERF_TD, 'max-w-[18rem] text-foreground')}>
                                <span
                                  className="block truncate font-medium"
                                  title={chat.subject ?? ''}
                                >
                                  {chat.subject ??
                                    t('performance.noSubject', {
                                      defaultValue: 'Chat (no ticket)',
                                    })}
                                </span>
                                {chat.orderId && (
                                  <span className="font-mono text-2xs text-muted-foreground">
                                    #{chat.orderId}
                                  </span>
                                )}
                              </td>
                              <td className={cn(PERF_TD, 'text-muted-foreground')}>
                                {/* The PHONE NUMBER, always (owner, 2026-10-11) -
                                    never the name, so every row reads the same way
                                    and can be matched to the customer directly. */}
                                <span
                                  className="block max-w-[12rem] truncate tabular-nums"
                                  dir="ltr"
                                >
                                  {(chat.customerPhone && normalizePhone(chat.customerPhone)) ||
                                    chat.customerPhone ||
                                    t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                                </span>
                              </td>
                              {!oneAgent && (
                                <td className={cn(PERF_TD, 'text-muted-foreground')}>
                                  {chat.agentName}
                                </td>
                              )}
                              <td className={cn(PERF_TD, 'tabular-nums text-muted-foreground')}>
                                {chat.startedAt ? formatDateTime(chat.startedAt) : '—'}
                              </td>
                              <td className={cn(PERF_TD, 'text-muted-foreground')}>
                                {chat.initiatedBy === 'agent'
                                  ? t('performance.byAgent', { defaultValue: 'Agent' })
                                  : t('performance.byCustomer', { defaultValue: 'Customer' })}
                              </td>
                              {/* "No reply" rather than a dash: the worst outcome on
                              the page must not read as missing data. */}
                              <td
                                className={cn(
                                  PERF_TD,
                                  'text-end tabular-nums',
                                  chat.passedOn || awaitingCustomer(chat)
                                    ? 'text-muted-foreground'
                                    : first == null
                                      ? 'font-semibold text-destructive'
                                      : 'text-foreground',
                                )}
                              >
                                {/* An agent-started chat the customer has not
                                answered has nothing to respond to yet. */}
                                {awaitingCustomer(chat)
                                  ? t('performance.customerNotReplied', {
                                      defaultValue: 'Customer hasn’t replied',
                                    })
                                  : first == null
                                    ? t('performance.noReplyYet', { defaultValue: 'No reply yet' })
                                    : formatDuration(first)}
                                {/* Says WHY this row is not counted against the
                                target, rather than leaving a slow-looking
                                number with no explanation beside it. */}
                                {chat.passedOn && (
                                  <span className="ms-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t('performance.commonChat', { defaultValue: 'common' })}
                                  </span>
                                )}
                              </td>
                              <td className={cn(PERF_TD, 'text-end tabular-nums text-foreground')}>
                                {solve == null ? (
                                  /* A CLOSED chat is never "Still open" — that was
                                 the agent-started chat with no customer reply,
                                 which has no customer message to time from. */
                                  <span className="text-muted-foreground">
                                    {chat.solvedAt
                                      ? awaitingCustomer(chat)
                                        ? t('performance.closedNoReply', {
                                            defaultValue: 'Closed — no customer reply',
                                          })
                                        : t('performance.closed', { defaultValue: 'Closed' })
                                      : awaitingCustomer(chat)
                                        ? t('performance.waitingCustomer', {
                                            defaultValue: 'Waiting for customer',
                                          })
                                        : t('performance.stillOpen', {
                                            defaultValue: 'Still open',
                                          })}
                                  </span>
                                ) : (
                                  formatDuration(solve)
                                )}
                              </td>
                              {/* This chat's own rating; empty when the customer
                                  did not rate (owner, 2026-10-11). */}
                              <td className={cn(PERF_TD, 'text-end tabular-nums text-foreground')}>
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
                    {/* THE CARD'S FOOT: the table's averages beside its pager,
                    inside the card, so the totals read next to their rows. */}
                    <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-foreground/[0.07] px-5 py-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="font-semibold">
                          {t('performance.avgFirst', { defaultValue: 'First response' })}
                        </span>
                        <span className="font-semibold tabular-nums text-foreground">
                          {formatDuration(summary.avgFirstResponseSec) ?? '—'}
                        </span>
                      </span>
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="font-semibold">
                          {t('performance.avgSolve', { defaultValue: 'Time to solve' })}
                        </span>
                        <span className="font-semibold tabular-nums text-foreground">
                          {formatDuration(summary.avgTimeToSolveSec) ?? '—'}
                        </span>
                      </span>
                      <TablePager
                        className="ms-auto"
                        page={breakdownCurrent}
                        onPage={setBreakdownPageNo}
                        pageSize={breakdownPageSize}
                        onPageSize={(n) => {
                          setBreakdownPageSize(n);
                          setBreakdownPageNo(1);
                        }}
                        total={breakdown.length}
                        pageSizes={[10, 25, 50, 100]}
                        labels={{
                          rowsPerPage: String(
                            t('performance.rowsPerPage', { defaultValue: 'Rows per page' }),
                          ),
                          previous: String(
                            t('actions.previous', { ns: 'common', defaultValue: 'Previous' }),
                          ),
                          next: String(t('actions.next', { ns: 'common', defaultValue: 'Next' })),
                          showing: ({ from, to, total }) =>
                            String(
                              t('performance.showingRange', {
                                defaultValue: '{{from}}–{{to}} of {{total}} chats',
                                from,
                                to,
                                total,
                              }),
                            ),
                        }}
                      />
                    </footer>
                  </section>
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
                })}{' '}
                {t('performance.outreachBasis', {
                  defaultValue:
                    'A chat an agent started is measured from the customer’s reply: first response is the agent’s answer to it, and time to solve runs from it to closing. Until the customer replies, the chat is not counted as unanswered or late.',
                })}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A chart in a card, with the question it answers written above it — thin
    adapter over the shared SectionCard surface so every chart carries the same
    header anatomy as the rest of the boards. */
function Card({
  title,
  help,
  children,
  className,
}: {
  title: string;
  help: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SectionCard title={title} hint={help} className={className}>
      {children}
    </SectionCard>
  );
}
