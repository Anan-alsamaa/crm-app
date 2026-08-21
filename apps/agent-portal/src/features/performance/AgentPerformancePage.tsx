import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Pill,
  SectionCard,
  SelectMenu,
  Skeleton,
  Toolbar,
  ToolbarSpacer,
  TrendChart,
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
} from '@yiji/reports';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useAgents } from '../inbox/api.js';
import {
  useChatTimings,
  useCsatByConversation,
  type ChatTimingRow,
  type PerformanceFilters,
} from './api.js';

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

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const agents = useAgents();

  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) {
      m.set(a.id, a.first_name?.trim() || a.email?.trim() || a.id);
    }
    return m;
  }, [agents.data]);

  const [filters, setFilters] = useState<PerformanceFilters>({});
  const [targetMin, setTargetMin] = useState(DEFAULT_TARGET_MIN);
  /** What is in the box WHILE typing — '' is a legal intermediate state. */
  const [targetDraft, setTargetDraft] = useState(String(DEFAULT_TARGET_MIN));

  const timings = useChatTimings(filters);
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
        // NEVER the raw id. A 36-character uuid beside real names is not a
        // degraded label, it is an unreadable one — and it happens for real:
        // the router can assign a chat to an account `useAgents` filters out,
        // and a /users error leaves every name unresolved. The skeleton gate
        // below also waits for the names, so the first paint cannot show one.
        agentName: c.agentId
          ? (agentNames.get(c.agentId) ??
            t('performance.unknownAgent', { defaultValue: 'Unknown agent' }))
          : t('performance.unassigned', { defaultValue: 'Unassigned' }),
      })),
    [timings.data, agentNames, t],
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
  const compare = useMemo(
    () =>
      comparisonRows(chats, (n) => t('performance.chatsCount', { defaultValue: '{{n}} chats', n })),
    [chats, t],
  );
  const trend = useMemo(() => dailyTrend(chats), [chats]);

  /** Slowest first, and the chats nobody answered lead — those are the ones to look at. */
  const breakdown = useMemo(
    () =>
      chats
        .map((c) => ({ chat: c, first: firstResponseSec(c), solve: timeToSolveSec(c) }))
        .sort((a, b) => {
          if (a.first == null && b.first != null) return -1;
          if (b.first == null && a.first != null) return 1;
          return (b.first ?? 0) - (a.first ?? 0);
        }),
    [chats],
  );

  /** Per-agent totals — the same shared rollup the admin console reports. */
  const csat = useCsatByConversation(filters);
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
        {/* Widths go on the WRAPPER, not the input: Input carries `w-full` in
            its base classes and `cn` is a plain joiner, not tailwind-merge, so
            a `w-…` passed through className is a coin toss against it. Sizing
            the box and letting the field fill it is the only stable version —
            without this the date fields ate the toolbar and the target box
            collapsed to a dot. */}
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
        <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {t('performance.targetShort', { defaultValue: 'Target' })}
          <span className="w-[4.5rem]">
            <Input
              type="number"
              min={1}
              className="h-8"
              aria-label={t('performance.target', { defaultValue: 'Answer within (minutes)' })}
              value={targetDraft}
              onChange={(e) => {
                setTargetDraft(e.target.value);
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) setTargetMin(n);
              }}
              onBlur={() => {
                // Only settle the value when the agent has finished. Clamping
                // per keystroke made the field impossible to clear and edit
                // from the keyboard — the spinner was the only way in.
                const n = Number(targetDraft);
                const settled = Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_TARGET_MIN;
                setTargetMin(settled);
                setTargetDraft(String(settled));
              }}
            />
          </span>
          {t('performance.minutesShort', { defaultValue: 'min' })}
        </label>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-6xl space-y-4">
          {timings.isLoading || agents.isLoading ? (
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
                title={t('performance.empty', { defaultValue: 'No chats match these filters.' })}
              />
            </div>
          ) : (
            <>
              {/* 1 — the headline. Five numbers, no chrome around them.
                  Named, so it is a landmark a screen-reader user can jump to
                  rather than five loose numbers before the charts. */}
              <section
                aria-label={t('performance.summary', { defaultValue: 'Summary' })}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                <Tile
                  label={t('performance.chats', { defaultValue: 'Chats' })}
                  value={String(summary.chats)}
                />
                <Tile
                  label={t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                  value={String(summary.unanswered)}
                  tone={summary.unanswered > 0 ? 'bad' : 'plain'}
                />
                <Tile
                  label={t('performance.metPct', { defaultValue: 'Answered in time' })}
                  value={summary.metPct == null ? '—' : `${summary.metPct}%`}
                  tone={summary.metPct == null ? 'plain' : summary.metPct >= 80 ? 'good' : 'bad'}
                  meter={
                    summary.metPct == null ? undefined : (
                      <MeterBar
                        value={summary.metPct}
                        tone={summary.metPct >= 80 ? 'success' : 'destructive'}
                        className="mt-2.5"
                      />
                    )
                  }
                />
                <Tile
                  label={t('performance.avgFirst', { defaultValue: 'First response' })}
                  value={formatDuration(summary.avgFirstResponseSec) ?? '—'}
                  hint={t('performance.average', { defaultValue: 'average' })}
                />
                <Tile
                  label={t('performance.avgSolve', { defaultValue: 'Time to solve' })}
                  value={formatDuration(summary.avgTimeToSolveSec) ?? '—'}
                  hint={t('performance.average', { defaultValue: 'average' })}
                />
                {/* Picking up a chat nobody else answered is worth its own
                    number: it never shows in a response-time average, and it is
                    the one thing on this page a person can decide to do more
                    of. */}
                {/* What the customer thought — the only measure here they do
                    not control by working faster. */}
                <Tile
                  label={t('performance.csat', { defaultValue: 'Customer rating' })}
                  value={csatOverall ? `${csatOverall.avg.toFixed(1)}/5` : '—'}
                  tone={csatOverall == null ? 'plain' : csatOverall.avg >= 4 ? 'good' : 'bad'}
                  hint={
                    csatOverall
                      ? t('performance.csatCount', {
                          defaultValue: '{{n}} rated',
                          n: csatOverall.n,
                        })
                      : undefined
                  }
                />
                <Tile
                  label={t('performance.commonChats', { defaultValue: 'Common chats taken' })}
                  value={String(summary.commonChats)}
                  tone={summary.commonChats > 0 ? 'good' : 'plain'}
                />
              </section>

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
                    title={t('performance.fastTitle', { defaultValue: 'How fast they replied' })}
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
                <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in">
                  <header className="flex items-baseline justify-between gap-3  px-5 py-4">
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
                        <tr className="tracking-[0.12em] bg-secondary/70 text-2xs uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]">
                          <th className="h-10 px-5 text-start font-semibold">
                            {t('performance.agent', { defaultValue: 'Agent' })}
                          </th>
                          <th className="h-10 px-5 text-start font-semibold">
                            {t('performance.chats', { defaultValue: 'Chats' })}
                          </th>
                          <th className="h-10 px-5 text-end font-semibold">
                            {t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                          </th>
                          <th className="h-10 px-5 text-end font-semibold">
                            {t('performance.commonChats', { defaultValue: 'Common chats taken' })}
                          </th>
                          <th className="h-10 px-5 text-end font-semibold">
                            {t('performance.avgFirstCol', { defaultValue: 'First response (avg)' })}
                          </th>
                          <th className="h-10 px-5 text-end font-semibold">
                            {t('performance.avgSolveCol', { defaultValue: 'Time to solve (avg)' })}
                          </th>
                          <th className="h-10 px-5 text-end font-semibold">
                            {t('performance.csat', { defaultValue: 'Customer rating' })}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y-0">
                        {totals.map((r) => (
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
                            <td className="px-5 py-3">
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
                              {formatDuration(r.avgFirstResponseSec) ?? '—'}
                            </td>
                            <td className="px-5 py-3 text-end tabular-nums text-muted-foreground">
                              {formatDuration(r.avgTimeToSolveSec) ?? '—'}
                            </td>
                            <td className="px-5 py-3 text-end tabular-nums">
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

              <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1  px-4 py-3">
                  <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                    {t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                  </h2>
                  <span className="text-2xs text-muted-foreground">
                    {t('performance.breakdownHelp', {
                      defaultValue: 'Slowest first. Open one to see what happened.',
                    })}
                  </span>
                  <span className="ms-auto text-2xs tabular-nums text-muted-foreground">
                    {breakdown.length}
                  </span>
                </header>
                <div className="max-h-[28rem] overflow-auto">
                  <table
                    className="w-full text-sm"
                    aria-label={t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                  >
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="tracking-[0.12em] bg-secondary/70 text-2xs uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]">
                        <th className="px-4 py-2.5 text-start font-semibold">
                          {t('performance.subject', { defaultValue: 'Complaint / chat' })}
                        </th>
                        <th className="px-4 py-2.5 text-start font-semibold">
                          {t('performance.customer', { defaultValue: 'Customer' })}
                        </th>
                        {!oneAgent && (
                          <th className="px-4 py-2.5 text-start font-semibold">
                            {t('performance.agent', { defaultValue: 'Agent' })}
                          </th>
                        )}
                        <th className="px-4 py-2.5 text-start font-semibold">
                          {t('performance.started', { defaultValue: 'Started' })}
                        </th>
                        <th className="px-4 py-2.5 text-end font-semibold">
                          {t('performance.firstResponse', { defaultValue: 'First response' })}
                        </th>
                        <th className="px-4 py-2.5 text-end font-semibold">
                          {t('performance.timeToSolve', { defaultValue: 'Time to solve' })}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map(({ chat, first, solve }) => (
                        <tr
                          key={chat.conversationId}
                          onClick={() =>
                            navigate(`/?conv=${encodeURIComponent(chat.conversationId)}`)
                          }
                          className="cursor-pointer border-t border-foreground/[0.06] transition-colors duration-fast hover:bg-primary/[0.07]"
                        >
                          <td className="max-w-[18rem] px-4 py-2.5 text-foreground">
                            <span className="block truncate font-medium" title={chat.subject ?? ''}>
                              {chat.subject ??
                                t('performance.noSubject', { defaultValue: 'Chat (no ticket)' })}
                            </span>
                            {chat.orderId && (
                              <span className="font-mono text-2xs text-muted-foreground">
                                #{chat.orderId}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            <span className="block max-w-[12rem] truncate">
                              {chat.customer ??
                                t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                            </span>
                          </td>
                          {!oneAgent && (
                            <td className="px-4 py-2.5 text-muted-foreground">{chat.agentName}</td>
                          )}
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                            {chat.startedAt ? formatDateTime(chat.startedAt) : '—'}
                          </td>
                          {/* "No reply" rather than a dash: the worst outcome on
                              the page must not read as missing data. */}
                          <td
                            className={cn(
                              'px-4 py-2.5 text-end tabular-nums',
                              chat.passedOn
                                ? 'text-muted-foreground'
                                : first == null
                                  ? 'font-semibold text-destructive'
                                  : 'text-foreground',
                            )}
                          >
                            {first == null
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
                          <td className="px-4 py-2.5 text-end tabular-nums text-foreground">
                            {solve == null ? (
                              <span className="text-muted-foreground">
                                {t('performance.stillOpen', { defaultValue: 'Still open' })}
                              </span>
                            ) : (
                              formatDuration(solve)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Footer aggregate band — the table's totals live on the table,
                    in the board idiom, so the averages read next to their rows. */}
                <footer className="flex h-11 flex-wrap items-center gap-x-6 gap-y-1 border-t border-foreground/[0.08] bg-foreground/[0.02] px-4 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {t('performance.chatsCount', {
                      defaultValue: '{{n}} chats',
                      n: breakdown.length,
                    })}
                  </span>
                  <span className="hidden items-baseline gap-1.5 sm:inline-flex">
                    <span className="text-2xs font-semibold uppercase tracking-[0.12em]">
                      {t('performance.avgFirst', { defaultValue: 'First response' })}
                    </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatDuration(summary.avgFirstResponseSec) ?? '—'}
                    </span>
                  </span>
                  <span className="hidden items-baseline gap-1.5 sm:inline-flex">
                    <span className="text-2xs font-semibold uppercase tracking-[0.12em]">
                      {t('performance.avgSolve', { defaultValue: 'Time to solve' })}
                    </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatDuration(summary.avgTimeToSolveSec) ?? '—'}
                    </span>
                  </span>
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
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

/** One headline number, in the board tile anatomy: extrabold numeral, tone dot
    beside the uppercase micro-label, optional meter accent underneath. */
function Tile({
  label,
  value,
  hint,
  tone = 'plain',
  meter,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
  /** Optional data accent under the label — pass a `<MeterBar>`. */
  meter?: ReactNode;
}) {
  return (
    /* The surface carries the tone as well as the numeral. Unlike the hue-coded
       KPI cards elsewhere, `tone` here means "is this metric healthy" — so a
       tinted surface is information, not decoration, and it pulls the eye to
       the two tiles that need attention instead of leaving seven identical
       white boxes to be read one at a time. */
    <div
      className={cn(
        'rounded-2xl px-4 py-3.5 shadow-soft ring-1',
        tone === 'bad'
          ? 'bg-gradient-to-br from-destructive-tint/70 to-card ring-destructive/15'
          : tone === 'good'
            ? 'bg-gradient-to-br from-success-tint/70 to-card ring-success/15'
            : 'bg-card ring-foreground/[0.06]',
      )}
    >
      <div
        className={cn(
          'text-2xl font-extrabold leading-none tracking-[-0.03em] tabular-nums',
          tone === 'bad'
            ? 'text-destructive'
            : tone === 'good'
              ? 'text-success'
              : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {tone !== 'plain' && (
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              tone === 'bad' ? 'bg-destructive' : 'bg-success',
            )}
          />
        )}
        {/* Wraps rather than truncates: at six-up these micro-labels were
            clipping to "COMMON CHATS TA…", which is not a label at all. */}
        <span className="min-w-0 leading-snug">
          {label}
          {hint && <span className="ms-1 font-normal normal-case tracking-normal">({hint})</span>}
        </span>
      </div>
      {meter}
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
