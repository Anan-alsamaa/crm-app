import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  HBarChart,
  Input,
  SelectMenu,
  Skeleton,
  Toolbar,
  ToolbarSpacer,
  TrendChart,
  cn,
  type ChartSeries,
} from '@yiji/ui';
import {
  comparisonRows,
  dailyTrend,
  firstResponseSec,
  formatDuration,
  performanceSummary,
  timeToSolveSec,
} from '@yiji/reports';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useAgents } from '../inbox/api.js';
import { useChatTimings, type ChatTimingRow, type PerformanceFilters } from './api.js';

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
    for (const a of agents.data ?? []) m.set(a.id, a.first_name ?? a.email ?? a.id);
    return m;
  }, [agents.data]);

  const [filters, setFilters] = useState<PerformanceFilters>({});
  const [targetMin, setTargetMin] = useState(DEFAULT_TARGET_MIN);

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
    { key: 'chats', label: t('performance.chats', { defaultValue: 'Chats' }), tone: 'sky' },
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

  const oneAgent = !!filters.agentId;
  const durFmt = (v: number) => formatDuration(v) ?? '—';
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
              label: a.first_name ?? a.email ?? a.id,
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
          <Input
            type="date"
            className="h-8"
            aria-label={t('performance.from', { defaultValue: 'From' })}
            value={filters.from ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </div>
        <div className="w-[8.75rem] shrink-0">
          <Input
            type="date"
            className="h-8"
            aria-label={t('performance.to', { defaultValue: 'To' })}
            value={filters.to ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
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
              value={targetMin}
              onChange={(e) => setTargetMin(Math.max(1, Number(e.target.value) || 1))}
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
            <p className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-soft">
              {t('performance.empty', { defaultValue: 'No chats match these filters.' })}
            </p>
          ) : (
            <>
              {/* 1 — the headline. Five numbers, no chrome around them.
                  Named, so it is a landmark a screen-reader user can jump to
                  rather than five loose numbers before the charts. */}
              <section
                aria-label={t('performance.summary', { defaultValue: 'Summary' })}
                className="grid grid-cols-2 gap-3 md:grid-cols-5"
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
                    />
                  </Card>
                  <Card
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
                  <TrendChart points={trend} series={volumeSeries} format={countFmt} />
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
              <section className="overflow-hidden rounded-2xl bg-card shadow-soft">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
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
                      <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
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
                          className="cursor-pointer border-t border-border/60 transition-colors duration-fast hover:bg-secondary/50"
                        >
                          <td className="px-4 py-2.5 text-foreground">
                            <span className="font-medium">
                              {chat.customer ??
                                t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                            </span>
                            {chat.orderId && (
                              <span className="ms-2 font-mono text-2xs text-muted-foreground">
                                #{chat.orderId}
                              </span>
                            )}
                          </td>
                          {!oneAgent && (
                            <td className="px-4 py-2.5 text-muted-foreground">{chat.agentName}</td>
                          )}
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                            {chat.startedAt ? new Date(chat.startedAt).toLocaleString() : '—'}
                          </td>
                          {/* "No reply" rather than a dash: the worst outcome on
                              the page must not read as missing data. */}
                          <td
                            className={cn(
                              'px-4 py-2.5 text-end tabular-nums',
                              first == null ? 'font-semibold text-destructive' : 'text-foreground',
                            )}
                          >
                            {first == null
                              ? t('performance.noReplyYet', { defaultValue: 'No reply yet' })
                              : formatDuration(first)}
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
              </section>
            </>
          )}

          <p className="px-1 pb-2 text-2xs leading-relaxed text-muted-foreground">
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

/** One headline number. No card chrome competing with it — the number is the thing. */
function Tile({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
}) {
  return (
    <div className="rounded-2xl bg-card px-4 py-3.5 shadow-soft">
      <div
        className={cn(
          'text-2xl font-bold leading-none tracking-[-0.02em] tabular-nums',
          tone === 'bad'
            ? 'text-destructive'
            : tone === 'good'
              ? 'text-success'
              : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
        {hint && <span className="ms-1 font-normal normal-case tracking-normal">({hint})</span>}
      </div>
    </div>
  );
}

/** A chart in a card, with the question it answers written above it. */
function Card({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-card p-4 shadow-soft">
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      <p className="mb-3 text-2xs text-muted-foreground">{help}</p>
      {children}
    </section>
  );
}
