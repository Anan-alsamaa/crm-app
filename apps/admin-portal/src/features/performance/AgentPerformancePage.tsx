import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { HBarChart, Input, SelectMenu, Skeleton, TrendChart, cn, type ChartSeries } from '@yiji/ui';
import { normaliseConversationStatus } from '@yiji/shared-types';
import {
  agentPerformance,
  comparisonRows,
  conversationTimestamps,
  dailyTrend,
  formatDuration,
  performanceSummary,
  type ChatTiming,
} from '@yiji/reports';
import { directus } from '../../lib/directus.js';

/**
 * Agent performance for the admin console.
 *
 * The same measures, the same layout and — crucially — the SAME arithmetic as
 * the agent portal: every number here comes out of @yiji/reports, so a
 * supervisor and an agent can never be looking at different figures for the
 * same week. What differs is only what a row does: nothing here opens a chat,
 * because an admin is reviewing the team rather than working the queue.
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

interface Filters {
  from?: string;
  to?: string;
  agentId?: string;
}

const endOfDay = (isoDate: string) => `${isoDate}T23:59:59.999Z`;

function useAgentList() {
  return useQuery({
    queryKey: ['perf-agents'],
    queryFn: () =>
      directus.request(
        readUsers({ limit: -1, fields: ['id', 'first_name', 'last_name', 'email'] }),
      ) as Promise<Array<{ id: string; first_name: string | null; email: string | null }>>,
  });
}

/** A `ChatTiming` plus the day it belongs to, which the trend chart buckets by. */
type AdminChatTiming = ChatTiming & { startedAt: string | null };

/**
 * Deliberately does NOT resolve agent names — see the user portal's copy of
 * this hook. The names come from a separate query, and a cache keyed only on
 * the filters will hold rows resolved against an empty map forever, rendering
 * uuids where names belong. Names are attached at render.
 */
function useChatTimings(filters: Filters) {
  return useQuery({
    queryKey: ['admin-chat-timings', filters],
    queryFn: async (): Promise<AdminChatTiming[]> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ date_created: { _gte: filters.from } });
      if (filters.to) and.push({ date_created: { _lte: endOfDay(filters.to) } });
      if (filters.agentId) and.push({ assigned_agent: { _eq: filters.agentId } });

      const conversations = (await directus.request(
        readItems(
          'conversations' as never,
          {
            limit: -1,
            fields: ['id', 'status', 'assigned_agent', 'solved_at', 'date_created'],
            ...(and.length ? { filter: { _and: and } } : {}),
          } as never,
        ),
      )) as unknown as Array<{
        id: string;
        status: string;
        assigned_agent: string | null;
        solved_at: string | null;
        date_created: string | null;
      }>;
      if (conversations.length === 0) return [];

      // First response needs the messages: the conversation row knows when it
      // started, never when somebody answered.
      const messages = (await directus.request(
        readItems(
          'messages' as never,
          {
            limit: -1,
            filter: {
              conversation: { _in: conversations.map((c) => c.id) },
              is_internal_note: { _eq: false },
            },
            fields: ['conversation', 'sender_type', 'date_created'],
            sort: ['date_created'],
          } as never,
        ),
      )) as unknown as Array<{
        conversation: string;
        sender_type: string;
        date_created: string | null;
      }>;

      // Shared with the agent portal — see conversationTimestamps in
      // @yiji/reports. Two portals reducing the same messages by hand is how
      // they came to agree on a wrong "No reply".
      const times = conversationTimestamps(messages);

      return conversations.map((c) => ({
        conversationId: c.id,
        agentId: c.assigned_agent,
        // Placeholder; the page replaces it with the resolved name.
        agentName: c.assigned_agent ?? 'Unassigned',
        firstCustomerAt: times.get(c.id)?.firstCustomerAt ?? null,
        firstAgentAt: times.get(c.id)?.firstAgentAt ?? null,
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
        // Carried so a chat nobody ever wrote in still lands on a day in the
        // trend instead of vanishing from it.
        startedAt: c.date_created,
      }));
    },
  });
}

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const agents = useAgentList();
  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) m.set(a.id, a.first_name ?? a.email ?? a.id);
    return m;
  }, [agents.data]);

  const [filters, setFilters] = useState<Filters>({});
  const [targetMin, setTargetMin] = useState(DEFAULT_TARGET_MIN);

  const timings = useChatTimings(filters);
  // Names attached here, not in the query — see the note on useChatTimings.
  const chats = useMemo<AdminChatTiming[]>(
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
  /** The full numbers per agent — this page's drill-down, since no row opens a chat. */
  const rows = useMemo(() => agentPerformance(chats), [chats]);

  const dash = <span className="text-muted-foreground/50">—</span>;
  const durFmt = (v: number) => formatDuration(v) ?? '—';
  const nothingMeasured = t('performance.nothingMeasured', {
    defaultValue: 'No chat in this range has been answered yet, so there is nothing to plot.',
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]">
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
                label: a.first_name ?? a.email ?? a.id,
              })),
            ]}
          />
        </Field>
        <Field label={t('performance.from', { defaultValue: 'From' })}>
          {/* Width on the wrapper — Input's base carries `w-full` and `cn` does
              not merge Tailwind classes, so a width passed through className is
              not reliably the winner. */}
          <span className="block w-[9.5rem]">
            <Input
              type="date"
              className="h-8"
              aria-label={t('performance.from', { defaultValue: 'From' })}
              value={filters.from ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </span>
        </Field>
        <Field label={t('performance.to', { defaultValue: 'To' })}>
          <span className="block w-[9.5rem]">
            <Input
              type="date"
              className="h-8"
              aria-label={t('performance.to', { defaultValue: 'To' })}
              value={filters.to ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </span>
        </Field>
        <Field label={t('performance.target', { defaultValue: 'Answer within (minutes)' })}>
          <span className="block w-[7rem]">
            <Input
              type="number"
              min={1}
              className="h-8"
              aria-label={t('performance.target', { defaultValue: 'Answer within (minutes)' })}
              value={targetMin}
              onChange={(e) => setTargetMin(Math.max(1, Number(e.target.value) || 1))}
            />
          </span>
        </Field>
      </div>

      {timings.isLoading || agents.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[5.5rem] w-full rounded-2xl" />
          <Skeleton className="h-56 w-full rounded-2xl" />
        </div>
      ) : chats.length === 0 ? (
        <p className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-soft">
          {t('performance.empty', { defaultValue: 'No chats match these filters.' })}
        </p>
      ) : (
        <>
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

          {!filters.agentId && (
            <section className="grid gap-4 lg:grid-cols-2">
              <Card
                title={t('performance.whoTitle', { defaultValue: 'Who handled the chats' })}
                help={t('performance.whoHelp', { defaultValue: 'Chats assigned in this range' })}
              >
                <HBarChart
                  rows={compare.map((r) => ({ label: r.label, values: r.values }))}
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
                  rows={compare.map((r) => ({ label: r.label, note: r.note, values: r.values }))}
                  series={timeSeries}
                  format={durFmt}
                  emptyLabel={nothingMeasured}
                />
              </Card>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-2">
            <Card
              title={t('performance.perDayTitle', { defaultValue: 'Chats per day' })}
              help={t('performance.perDayHelp', { defaultValue: 'How busy each day was' })}
            >
              <TrendChart points={trend} series={volumeSeries} format={countFmt} />
            </Card>
            <Card
              title={t('performance.speedPerDayTitle', { defaultValue: 'Response times per day' })}
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

          {/* The numbers behind the charts. No row opens anything — this page
              reviews the team, it does not work the queue. */}
          <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
            <header className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                {t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
              </h2>
            </header>
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label={t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
              >
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-start font-semibold">
                      {t('performance.agent', { defaultValue: 'Agent' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.chats', { defaultValue: 'Chats' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.noReplyYet', { defaultValue: 'No reply yet' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.avgFirstCol', { defaultValue: 'First response (avg)' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.medFirst', { defaultValue: 'First response (median)' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.solved', { defaultValue: 'Solved' })}
                    </th>
                    <th className="px-4 py-2.5 text-end font-semibold">
                      {t('performance.avgSolveCol', { defaultValue: 'Time to solve (avg)' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.agentId ?? 'unassigned'} className="border-t border-border/60">
                      <td className="px-4 py-2.5 font-medium text-foreground">{r.agentName}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums">{r.chats}</td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-end tabular-nums',
                          r.unanswered > 0 ? 'font-semibold text-destructive' : '',
                        )}
                      >
                        {r.unanswered}
                      </td>
                      <td className="px-4 py-2.5 text-end tabular-nums">
                        {formatDuration(r.avgFirstResponseSec) ?? dash}
                      </td>
                      <td className="px-4 py-2.5 text-end tabular-nums">
                        {formatDuration(r.medianFirstResponseSec) ?? dash}
                      </td>
                      <td className="px-4 py-2.5 text-end tabular-nums">{r.solved}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums">
                        {formatDuration(r.avgTimeToSolveSec) ?? dash}
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
  );
}

/** A filter control with its name above it. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

/** One headline number. */
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
    <div className="rounded-2xl bg-card px-4 py-3.5 shadow-soft ring-1 ring-foreground/[0.06]">
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
    <section className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      <p className="mb-3 text-2xs text-muted-foreground">{help}</p>
      {children}
    </section>
  );
}
