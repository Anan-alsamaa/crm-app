import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { Input, SelectMenu, Skeleton, cn } from '@yiji/ui';
import { normaliseConversationStatus } from '@yiji/shared-types';
import { agentPerformance, formatDuration, splitBySla, type ChatTiming } from '@yiji/reports';
import { directus } from '../../lib/directus.js';

/**
 * Agent performance for the admin console: the same two measures the user
 * portal shows, computed by the SAME module in @yiji/reports so a supervisor
 * and an agent can never be looking at different numbers for the same week.
 *
 * READ ONLY by request. No row opens a chat and there is no inbox surface here
 * — an admin is reviewing the team, not working the queue.
 */
const DEFAULT_TARGET_MIN = 5;

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

/**
 * Deliberately does NOT resolve agent names — see the user portal's copy of
 * this hook. The names come from a separate query, and a cache keyed only on
 * the filters will hold rows resolved against an empty map forever, rendering
 * uuids where names belong. Names are attached at render.
 */
function useChatTimings(filters: Filters) {
  return useQuery({
    queryKey: ['admin-chat-timings', filters],
    queryFn: async (): Promise<ChatTiming[]> => {
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

      const firstCustomer = new Map<string, string>();
      const firstAgent = new Map<string, string>();
      for (const m of messages) {
        if (!m.date_created) continue;
        const bucket =
          m.sender_type === 'customer'
            ? firstCustomer
            : m.sender_type === 'agent'
              ? firstAgent
              : null;
        if (!bucket || bucket.has(m.conversation)) continue;
        bucket.set(m.conversation, m.date_created);
      }

      return conversations.map((c) => ({
        conversationId: c.id,
        agentId: c.assigned_agent,
        // Placeholder; the page replaces it with the resolved name.
        agentName: c.assigned_agent ?? 'Unassigned',
        firstCustomerAt: firstCustomer.get(c.id) ?? null,
        firstAgentAt: firstAgent.get(c.id) ?? null,
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
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
  const [view, setView] = useState<'met' | 'missed'>('missed');

  const timings = useChatTimings(filters);
  // Names attached here, not in the query — see the note on useChatTimings.
  const chats = useMemo<ChatTiming[]>(
    () =>
      (timings.data ?? []).map((c) => ({
        ...c,
        agentName: c.agentId
          ? (agentNames.get(c.agentId) ?? c.agentId)
          : t('performance.unassigned', { defaultValue: 'Unassigned' }),
      })),
    [timings.data, agentNames, t],
  );
  const { met, missed } = useMemo(() => splitBySla(chats, targetMin * 60), [chats, targetMin]);
  const rows = useMemo(() => agentPerformance(view === 'met' ? met : missed), [view, met, missed]);

  const dash = <span className="text-muted-foreground/50">—</span>;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]">
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
        <div className="ms-auto flex overflow-hidden rounded-md ring-1 ring-border">
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

      {timings.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl bg-card p-8 text-center text-sm text-muted-foreground shadow-soft">
          {t('performance.empty', { defaultValue: 'No chats match these filters.' })}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
          <table className="w-full text-sm">
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
        </div>
      )}

      <p className="px-1 text-2xs leading-relaxed text-muted-foreground">
        {t('performance.basis', {
          defaultValue:
            'First response is measured from the customer’s first message to the first agent reply. Internal notes do not count as a reply. Chats nobody answered are counted under "No reply" and left out of the averages.',
        })}
      </p>
    </div>
  );
}
