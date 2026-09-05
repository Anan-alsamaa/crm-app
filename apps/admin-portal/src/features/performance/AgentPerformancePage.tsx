import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  BellIcon,
  Button,
  ChartIcon,
  ClockIcon,
  cn,
  DateField,
  EmptyState,
  formatDateTime,
  HBarChart,
  InboxIcon,
  Input,
  MeterBar,
  Pill,
  ProgressRing,
  SectionCard,
  SelectMenu,
  Skeleton,
  Toolbar,
  ToolbarSpacer,
  TrendChart,
  type ChartSeries,
  UsersIcon,
  ZapIcon,
} from '@yiji/ui';
import { normaliseConversationStatus } from '@yiji/shared-types';
import {
  agentPerformance,
  chatHandoffs,
  comparisonRows,
  conversationTimestamps,
  readChunked,
  dailyTrend,
  firstResponseSec,
  formatDuration,
  performanceSummary,
  timeToSolveSec,
  type ChatTiming,
} from '@yiji/reports';
import { directus } from '../../lib/directus.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';
import { exportFileName } from '@yiji/shared-config';

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
type AdminChatTiming = ChatTiming & {
  startedAt: string | null;
  /** Who the chat was with — name, else the phone we recognise them by. */
  customer: string | null;
  /** What it was ABOUT: the linked ticket's complaint type, else its subject. */
  subject: string | null;
};

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
            fields: [
              'id',
              'status',
              'assigned_agent',
              'solved_at',
              'date_created',
              { contact: ['id', 'name', 'phone'] },
            ],
            ...(and.length ? { filter: { _and: and } } : {}),
          } as never,
        ),
      )) as unknown as Array<{
        id: string;
        status: string;
        assigned_agent: string | null;
        solved_at: string | null;
        date_created: string | null;
        contact: { id: string; name: string | null; phone: string | null } | null;
      }>;
      if (conversations.length === 0) return [];

      /* What each chat was about. Read separately — the subject lives on the
       * ticket, and a chat with no ticket simply has none. Best-effort so a
       * permissions gap cannot empty the page. */
      const subjectOf = new Map<string, string>();
      try {
        // Chunked: every conversation id in one query string is an HTTP 414
        // from CloudFront once the count grows. See readChunked.
        const linked = await readChunked<{
          conversation: string | null;
          subject: string | null;
          complaint_type: string | null;
        }>(
          conversations.map((c) => c.id),
          (ids) =>
            directus.request(
              readItems(
                'tickets' as never,
                {
                  limit: -1,
                  filter: { conversation: { _in: ids } },
                  fields: ['conversation', 'subject', 'complaint_type'],
                  sort: ['-date_created'],
                } as never,
              ),
            ) as unknown as Promise<
              Array<{
                conversation: string | null;
                subject: string | null;
                complaint_type: string | null;
              }>
            >,
        );
        for (const tk of linked) {
          if (!tk.conversation) continue;
          const label = tk.complaint_type?.trim() || tk.subject?.trim();
          // Newest ticket wins — the sort above puts it first.
          if (label && !subjectOf.has(tk.conversation)) subjectOf.set(tk.conversation, label);
        }
      } catch {
        /* no ticket read access — rows fall back to the customer alone */
      }

      // First response needs the messages: the conversation row knows when it
      // started, never when somebody answered.
      const messages = await readChunked<{
        conversation: string;
        sender_type: string;
        date_created: string | null;
      }>(
        conversations.map((c) => c.id),
        (ids) =>
          directus.request(
            readItems(
              'messages' as never,
              {
                limit: -1,
                filter: {
                  conversation: { _in: ids },
                  is_internal_note: { _eq: false },
                },
                fields: ['conversation', 'sender_type', 'date_created'],
                sort: ['date_created'],
              } as never,
            ),
          ) as unknown as Promise<
            Array<{ conversation: string; sender_type: string; date_created: string | null }>
          >,
      );

      // Shared with the agent portal — see conversationTimestamps in
      // @yiji/reports. Two portals reducing the same messages by hand is how
      // they came to agree on a wrong "No reply".
      const times = conversationTimestamps(messages);

      /**
       * Which chats the ladder had to pass on — see chatHandoffs in
       * @yiji/reports. Those leave the personal first-response population and
       * become COMMON chats for whoever picked them up, because the wait they
       * carry was created by the agents who did not answer first.
       */
      let handoffs = new Map<string, { passedOn: boolean; takenBy: string | null }>();
      try {
        const events = (await readChunked<{
          conversation: string;
          agent: string | null;
          outcome: string;
          stage: string;
        }>(
          conversations.map((c) => c.id),
          (ids) =>
            directus.request(
              readItems(
                'routing_events' as never,
                {
                  limit: -1,
                  filter: { conversation: { _in: ids } },
                  fields: ['conversation', 'agent', 'outcome', 'stage'],
                } as never,
              ),
            ) as unknown as Promise<
              Array<{
                conversation: string;
                agent: string | null;
                outcome: string;
                stage: string;
              }>
            >,
        )) as unknown as Array<{
          conversation: string;
          agent: string | null;
          outcome: string;
          stage: string;
        }>;
        handoffs = chatHandoffs(events);
      } catch {
        /* no routing history readable — every chat counts as cleanly assigned */
      }

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
        customer: c.contact?.name ?? c.contact?.phone ?? null,
        subject: subjectOf.get(c.id) ?? null,
        passedOn: handoffs.get(c.id)?.passedOn ?? false,
        takenBy: handoffs.get(c.id)?.takenBy ?? null,
      }));
    },
  });
}

/**
 * CSAT for the chats in range, keyed by conversation — see the agent portal's
 * copy for why it is a separate read.
 */
function useCsatByConversation(filters: Filters) {
  return useQuery({
    queryKey: ['admin-csat-by-conversation', filters],
    queryFn: async (): Promise<Map<string, number>> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ submitted_at: { _gte: filters.from } });
      if (filters.to) and.push({ submitted_at: { _lte: endOfDay(filters.to) } });
      const rows = (await directus.request(
        readItems(
          'csat_responses' as never,
          {
            limit: -1,
            fields: ['conversation', 'score'],
            ...(and.length ? { filter: { _and: and } } : {}),
          } as never,
        ),
      )) as unknown as Array<{ conversation: string | null; score: number | null }>;
      const out = new Map<string, number>();
      for (const r of rows) {
        if (!r.conversation || typeof r.score !== 'number') continue;
        out.set(r.conversation, r.score);
      }
      return out;
    },
  });
}

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const agents = useAgentList();
  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) {
      m.set(a.id, a.first_name?.trim() || a.email?.trim() || a.id);
    }
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
  const compare = useMemo(
    () =>
      comparisonRows(chats, (n) => t('performance.chatsCount', { defaultValue: '{{n}} chats', n })),
    [chats, t],
  );
  const trend = useMemo(() => dailyTrend(chats), [chats]);
  /** The full numbers per agent — this page's drill-down, since no row opens a chat. */
  const rows = useMemo(() => agentPerformance(chats), [chats]);

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
  const csat = useCsatByConversation(filters);
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

  /* Chat by chat — slowest first, and chats nobody answered at the very top,
   * because "no reply" is the thing a supervisor must act on today. Same
   * ordering rule as the agent portal's copy. */
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
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('performance.title', { defaultValue: 'Agent performance' })}
        </h1>
        <ToolbarSpacer />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          {t('stores.export', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      {/* The shell's <main> is overflow-hidden by design — every page owns its
          scroll. This one didn't, so everything below the first screenful was
          simply unreachable. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
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
            // Composed empty state on the card surface — a bare sentence floating
            // in a screenful of canvas read as a rendering failure.
            <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              <EmptyState
                icon={<InboxIcon size={22} />}
                title={t('performance.empty', { defaultValue: 'No chats match these filters.' })}
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
                  tone={summary.metPct == null ? 'plain' : summary.metPct >= 80 ? 'good' : 'bad'}
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
                    title={t('performance.commonTitle', {
                      defaultValue: 'Chats picked up for the team',
                    })}
                    help={t('performance.commonHelp', {
                      defaultValue: 'Chats answered after somebody else let them go',
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
                    title={t('performance.fastTitle', { defaultValue: 'How fast they replied' })}
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
                    aria-label={t('performance.summaryTable', { defaultValue: 'Totals per agent' })}
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
                          {t('performance.avgFirstCol', { defaultValue: 'First response' })}
                        </th>
                        <th className="h-10 px-5 text-end font-semibold">
                          {t('performance.solved', { defaultValue: 'Solved' })}
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
                                value={(r.chats / Math.max(1, ...rows.map((x) => x.chats))) * 100}
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
                              if (!c) return <span className="text-muted-foreground">{dash}</span>;
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

              {/* Chat by chat — the six columns the owner asked for. A row
                  opens the conversation in the agent portal, which is where a
                  supervisor goes to see what was actually said. */}
              <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in">
                <header className="flex items-baseline justify-between gap-3  px-5 py-4">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    {t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                  </h2>
                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                    {breakdown.length}
                  </span>
                </header>
                <div className="max-h-[32rem] overflow-auto">
                  <table
                    className="w-full min-w-max text-sm"
                    aria-label={t('performance.breakdownTitle', { defaultValue: 'Chat by chat' })}
                  >
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="tracking-[0.12em] bg-secondary/70 text-2xs uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]">
                        <th className="h-10 px-5 text-start font-semibold">
                          {t('performance.subject', { defaultValue: 'Ticket / chat' })}
                        </th>
                        <th className="h-10 px-5 text-start font-semibold">
                          {t('performance.customer', { defaultValue: 'Customer' })}
                        </th>
                        <th className="h-10 px-5 text-start font-semibold">
                          {t('performance.agent', { defaultValue: 'Agent' })}
                        </th>
                        <th className="h-10 px-5 text-start font-semibold">
                          {t('performance.started', { defaultValue: 'Started' })}
                        </th>
                        <th className="h-10 px-5 text-end font-semibold">
                          {t('performance.firstResponse', { defaultValue: 'First response' })}
                        </th>
                        <th className="h-10 px-5 text-end font-semibold">
                          {t('performance.timeToSolve', { defaultValue: 'Time to solve' })}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-0">
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
                                t('performance.noSubject', { defaultValue: 'Chat (no ticket)' })}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-muted-foreground">
                            <span className="block max-w-[12rem] truncate">
                              {chat.customer ??
                                t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <span className="flex items-center gap-2">
                              <Avatar name={chat.agentName} size="sm" />
                              <span className="truncate text-foreground">{chat.agentName}</span>
                            </span>
                          </td>
                          <td className="px-5 py-3 tabular-nums text-muted-foreground">
                            {chat.startedAt ? formatDateTime(chat.startedAt) : dash}
                          </td>
                          {/* "No reply" rather than a dash: the worst outcome
                              on the page must not read as missing data. */}
                          <td
                            className={cn(
                              'px-5 py-3 text-end tabular-nums',
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
                          </td>
                          <td className="px-5 py-3 text-end tabular-nums text-muted-foreground">
                            {solve == null ? dash : formatDuration(solve)}
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

/** A filter control with its name above it. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

/* The boards' KPI chip fills — `--<hue>-tint` + hue pairs, matching the
 * Overview's KPI row so the two console dashboards read as one system.
 * `--warning` stays out: its glyph contrast on the tint fails 3:1 on light. */
const TILE_CHIPS = {
  neutral: 'bg-secondary text-foreground',
  sky: 'bg-sky-tint text-sky',
  violet: 'bg-violet-tint text-violet',
  success: 'bg-success-tint text-success',
  destructive: 'bg-destructive-tint text-destructive',
} as const;

/** One headline number — board anatomy: icon chip, hue numeral, micro-label, optional data accent. */
function Tile({
  label,
  value,
  hint,
  tone = 'plain',
  chip = 'neutral',
  icon,
  visual,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
  /** Chip hue — the tile's identity color, independent of the value's verdict. */
  chip?: keyof typeof TILE_CHIPS;
  icon?: ReactNode;
  visual?: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex items-start gap-3">
        {icon && (
          <span
            aria-hidden
            className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', TILE_CHIPS[chip])}
          >
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
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
          {/* Wraps rather than truncates: at six-up these labels used to shear
              to "ANSWERED W…", which is a label that names nothing. */}
          <div className="mt-2 text-2xs font-semibold uppercase leading-snug tracking-[0.12em] text-muted-foreground">
            {label}
            {hint && <span className="ms-1 font-normal normal-case tracking-normal">({hint})</span>}
          </div>
        </div>
        {visual && <div className="shrink-0 self-center">{visual}</div>}
      </div>
    </div>
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
  // Delegates to the shared board surface so every section carries the same
  // header anatomy as the rest of the console.
  return (
    <SectionCard title={title} hint={help} className={className}>
      {children}
    </SectionCard>
  );
}
