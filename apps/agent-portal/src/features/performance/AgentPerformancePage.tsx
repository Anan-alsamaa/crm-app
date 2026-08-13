import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  HBarChart,
  Input,
  SelectMenu,
  Skeleton,
  SplitBar,
  Toolbar,
  ToolbarSpacer,
  TrendChart,
  cn,
  type ChartSeries,
} from '@yiji/ui';
import {
  agentPerformance,
  firstResponseSec,
  formatDuration,
  splitBySla,
  timeToSolveSec,
} from '@yiji/reports';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useAgents } from '../inbox/api.js';
import { useChatTimings, type ChatTimingRow, type PerformanceFilters } from './api.js';

/**
 * How fast the team answers, how long a chat takes to finish, and — chat by
 * chat — every conversation behind those numbers.
 *
 * Three layers, deliberately in this order:
 *
 *   1. the split against the target, because "am I meeting it" is the question
 *      anybody opens this page with;
 *   2. the comparison, which is the thing a table of averages cannot do — nine
 *      rows of "4m 12s" is nine numbers to hold in your head, and the same nine
 *      as bars is one glance;
 *   3. the chats themselves, so a number can be followed to the conversation
 *      that caused it. An average nobody can drill into is an accusation.
 *
 * Still two populations rather than one blended average: "met" and "missed"
 * are read side by side, because an average that mixes them tells a supervisor
 * the temperature of the room and nothing they can act on.
 *
 * The SLA target is a control rather than a constant so this page cannot
 * silently disagree with the SLA policies; wiring it to sla_policies is the
 * follow-up.
 */
const DEFAULT_TARGET_MIN = 5;

type View = 'met' | 'missed';

const SERIES: ChartSeries[] = [
  { key: 'first', label: 'First response', tone: 'primary' },
  { key: 'solve', label: 'Time to solve', tone: 'violet' },
];

/** `2026-08-13T…` → `2026-08-13`, the chat's local calendar day. */
function dayKey(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const agents = useAgents();

  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) {
      m.set(a.id, a.first_name ?? a.email ?? a.id);
    }
    return m;
  }, [agents.data]);

  const [filters, setFilters] = useState<PerformanceFilters>({});
  const [targetMin, setTargetMin] = useState(DEFAULT_TARGET_MIN);
  const [view, setView] = useState<View>('missed');

  const timings = useChatTimings(filters);
  /**
   * Names are attached HERE, not inside the query.
   *
   * The two come from different requests, so a query cached under the filters
   * alone will happily hold rows resolved against an empty name map — which is
   * how this page once rendered agent uuids where names belong.
   */
  const chats = useMemo<ChatTimingRow[]>(
    () =>
      (timings.data ?? []).map((c) => ({
        ...c,
        agentName: c.agentId
          ? (agentNames.get(c.agentId) ?? c.agentId)
          : t('conversation.unassigned', { defaultValue: 'Unassigned' }),
      })),
    [timings.data, agentNames, t],
  );

  const { met, missed } = useMemo(() => splitBySla(chats, targetMin * 60), [chats, targetMin]);
  const population = (view === 'met' ? met : missed) as ChatTimingRow[];
  const rows = useMemo(() => agentPerformance(population), [population]);

  /** One row per agent, for the comparison chart. Busiest first, as the table. */
  const compare = useMemo(
    () =>
      agentPerformance(chats).map((r) => ({
        label: r.agentName,
        note: t('performance.chatsCount', { defaultValue: '{{n}} chats', n: r.chats }),
        highlight: r.agentId === user?.id,
        values: { first: r.avgFirstResponseSec, solve: r.avgTimeToSolveSec },
      })),
    [chats, t, user?.id],
  );

  /** Daily averages across whatever is in range. */
  const trend = useMemo(() => {
    const byDay = new Map<string, { first: number[]; solve: number[] }>();
    for (const c of chats) {
      const key = dayKey(c.firstCustomerAt ?? c.startedAt);
      if (!key) continue;
      const bucket = byDay.get(key) ?? { first: [], solve: [] };
      const fr = firstResponseSec(c);
      const ts = timeToSolveSec(c);
      if (fr != null) bucket.first.push(fr);
      if (ts != null) bucket.solve.push(ts);
      byDay.set(key, bucket);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, v]) => ({
        // Day and month only: the year is the same on every point and eats the
        // width the dates need.
        label: label.slice(5),
        values: { first: mean(v.first), solve: mean(v.solve) },
      }));
  }, [chats]);

  /** The chats behind the numbers, slowest first — the ones worth looking at. */
  const breakdown = useMemo(
    () =>
      [...population]
        .map((c) => ({ chat: c, first: firstResponseSec(c), solve: timeToSolveSec(c) }))
        .sort((a, b) => {
          // Unanswered first: no reply at all outranks a slow one.
          if (a.first == null && b.first != null) return -1;
          if (b.first == null && a.first != null) return 1;
          return (b.first ?? 0) - (a.first ?? 0);
        }),
    [population],
  );

  const oneAgent = !!filters.agentId;
  const dash = <span className="text-muted-foreground/50">—</span>;
  const seriesLabelled = SERIES.map((s) => ({
    ...s,
    label:
      s.key === 'first'
        ? t('performance.avgFirst', { defaultValue: 'First response (avg)' })
        : t('performance.avgSolve', { defaultValue: 'Time to solve (avg)' }),
  }));

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('performance.title', { defaultValue: 'Agent performance' })}
        </h1>
        <ToolbarSpacer />
        <span className="text-2xs text-muted-foreground">
          {t('performance.chatsInRange', {
            defaultValue: '{{n}} chats in range',
            n: chats.length,
          })}
        </span>
      </Toolbar>

      <div className="flex flex-wrap items-end gap-2 border-b border-border bg-card px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('performance.agent', { defaultValue: 'Agent' })}
          </span>
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
                label: a.first_name ?? a.email ?? a.id,
              })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('performance.from', { defaultValue: 'From' })}
          </span>
          <Input
            type="date"
            className="h-9 w-[9.5rem]"
            value={filters.from ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('performance.to', { defaultValue: 'To' })}
          </span>
          <Input
            type="date"
            className="h-9 w-[9.5rem]"
            value={filters.to ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('performance.target', { defaultValue: 'Answer within (min)' })}
          </span>
          <Input
            type="number"
            min={1}
            className="h-9 w-[7rem]"
            value={targetMin}
            onChange={(e) => setTargetMin(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <ToolbarSpacer />
        {/* Two populations, never blended. */}
        <div className="flex overflow-hidden rounded-md ring-1 ring-border">
          {(['missed', 'met'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold transition-colors duration-fast ease-out',
                view === v
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              {v === 'met'
                ? t('performance.meeting', { defaultValue: 'Meeting SLA' })
                : t('performance.notMeeting', { defaultValue: 'Not meeting SLA' })}
              <span className="ms-1.5 tabular-nums opacity-70">
                {v === 'met' ? met.length : missed.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {timings.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-2xl" />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {t('performance.empty', { defaultValue: 'No chats match these filters.' })}
          </p>
        ) : (
          <>
            {/* 1 — the answer to the question the page is opened with. */}
            <section className="rounded-2xl bg-card p-4 shadow-soft">
              <h2 className="mb-3 text-sm font-semibold tracking-[-0.01em] text-foreground">
                {t('performance.againstTarget', {
                  defaultValue: 'Against a {{n}}-minute first response',
                  n: targetMin,
                })}
              </h2>
              <SplitBar
                parts={[
                  {
                    label: t('performance.meeting', { defaultValue: 'Meeting SLA' }),
                    value: met.length,
                    tone: 'success',
                  },
                  {
                    label: t('performance.notMeeting', { defaultValue: 'Not meeting SLA' }),
                    value: missed.length,
                    tone: 'destructive',
                  },
                ]}
              />
            </section>

            {/* 2 — the comparison. Only when looking at everybody: a bar chart
                of one agent against themselves compares nothing. */}
            {!oneAgent && (
              <section className="rounded-2xl bg-card p-4 shadow-soft">
                <h2 className="mb-1 text-sm font-semibold tracking-[-0.01em] text-foreground">
                  {t('performance.compareTitle', { defaultValue: 'Agent by agent' })}
                </h2>
                <p className="mb-3 text-2xs leading-relaxed text-muted-foreground">
                  {t('performance.compareHelp', {
                    defaultValue:
                      'Averages across every chat in range, answered ones only. Shorter is better.',
                  })}
                </p>
                <HBarChart
                  rows={compare}
                  series={seriesLabelled}
                  format={(v) => formatDuration(v) ?? '—'}
                  emptyLabel={t('performance.empty', {
                    defaultValue: 'No chats match these filters.',
                  })}
                />
              </section>
            )}

            {/* The shape of the week — where a bad average came from. */}
            <section className="rounded-2xl bg-card p-4 shadow-soft">
              <h2 className="mb-3 text-sm font-semibold tracking-[-0.01em] text-foreground">
                {t('performance.trendTitle', { defaultValue: 'Day by day' })}
              </h2>
              <TrendChart
                points={trend}
                series={seriesLabelled}
                format={(v) => formatDuration(v) ?? '—'}
                // NOT "no chats match" — there are chats, none of them
                // answered. Saying the filter is empty when it is not sends
                // somebody looking for a filter bug.
                emptyLabel={t('performance.nothingMeasured', {
                  defaultValue:
                    'No chat in range has been answered yet, so there is nothing to plot.',
                })}
              />
            </section>

            {/* The table that was here before — kept, because a chart answers
                "who" and a table answers "exactly how much". */}
            <section className="overflow-x-auto rounded-2xl bg-card shadow-soft">
              {/* Named, because the page now has two tables and a screen reader
                  landing on either needs to know which one it is in. */}
              <table
                className="w-full text-sm"
                aria-label={t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
              >
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2.5 text-start font-semibold">
                      {t('performance.agent', { defaultValue: 'Agent' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.chats', { defaultValue: 'Chats' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.unanswered', { defaultValue: 'No reply' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.avgFirst', { defaultValue: 'First response (avg)' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.medFirst', { defaultValue: 'First response (median)' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.solved', { defaultValue: 'Solved' })}
                    </th>
                    <th className="px-3 py-2.5 text-end font-semibold">
                      {t('performance.avgSolve', { defaultValue: 'Time to solve (avg)' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.agentId ?? 'unassigned'} className="border-t border-border/60">
                      <td className="px-3 py-2.5 font-medium text-foreground">{r.agentName}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{r.chats}</td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-end tabular-nums',
                          // Never blended into the averages, and never
                          // invisible: a non-zero here says the averages
                          // describe only part of this agent's work.
                          r.unanswered > 0 ? 'font-semibold text-destructive' : '',
                        )}
                      >
                        {r.unanswered}
                      </td>
                      <td className="px-3 py-2.5 text-end tabular-nums">
                        {formatDuration(r.avgFirstResponseSec) ?? dash}
                      </td>
                      <td className="px-3 py-2.5 text-end tabular-nums">
                        {formatDuration(r.medianFirstResponseSec) ?? dash}
                      </td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{r.solved}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums">
                        {formatDuration(r.avgTimeToSolveSec) ?? dash}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* 3 — the chats themselves. */}
            <section className="overflow-hidden rounded-2xl bg-card shadow-soft">
              <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                  {t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                </h2>
                <span className="text-2xs text-muted-foreground">
                  {t('performance.breakdownHelp', {
                    defaultValue: 'Slowest first. Click one to open it.',
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
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2.5 text-start font-semibold">
                        {t('performance.customer', { defaultValue: 'Customer' })}
                      </th>
                      {!oneAgent && (
                        <th className="px-3 py-2.5 text-start font-semibold">
                          {t('performance.agent', { defaultValue: 'Agent' })}
                        </th>
                      )}
                      <th className="px-3 py-2.5 text-start font-semibold">
                        {t('performance.started', { defaultValue: 'Started' })}
                      </th>
                      <th className="px-3 py-2.5 text-end font-semibold">
                        {t('performance.firstResponse', { defaultValue: 'First response' })}
                      </th>
                      <th className="px-3 py-2.5 text-end font-semibold">
                        {t('performance.totalTime', { defaultValue: 'Total chat time' })}
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
                        <td className="px-3 py-2 text-foreground">
                          <span className="font-medium">
                            {chat.customer ??
                              t('inbox.unknownContact', { defaultValue: 'Customer' })}
                          </span>
                          {chat.orderId && (
                            <span className="ms-2 font-mono text-2xs text-muted-foreground">
                              #{chat.orderId}
                            </span>
                          )}
                        </td>
                        {!oneAgent && (
                          <td className="px-3 py-2 text-muted-foreground">{chat.agentName}</td>
                        )}
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {chat.startedAt ? new Date(chat.startedAt).toLocaleString() : dash}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-end tabular-nums',
                            first == null ? 'font-semibold text-destructive' : 'text-foreground',
                          )}
                        >
                          {/* "No reply" rather than a dash: this is the worst
                              outcome on the page and must not read as missing
                              data. */}
                          {first == null
                            ? t('performance.noReply', { defaultValue: 'No reply' })
                            : formatDuration(first)}
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums text-foreground">
                          {solve == null
                            ? t('performance.stillOpen', { defaultValue: 'Still open' })
                            : formatDuration(solve)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        <p className="px-1 pt-1 text-2xs leading-relaxed text-muted-foreground">
          {t('performance.basis', {
            defaultValue:
              'First response is measured from the customer’s first message to the first agent reply. Internal notes do not count as a reply. Chats nobody answered are counted under "No reply" and left out of the averages.',
          })}
        </p>
      </div>
    </div>
  );
}
