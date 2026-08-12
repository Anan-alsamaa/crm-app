import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Input, SelectMenu, Skeleton, Toolbar, ToolbarSpacer, cn } from '@yiji/ui';
import { agentPerformance, formatDuration, splitBySla, type ChatTiming } from '@yiji/reports';
import { useAgents } from '../inbox/api.js';
import { useChatTimings, type PerformanceFilters } from './api.js';

/**
 * How fast the team answers, and how long a chat takes to finish.
 *
 * Deliberately two populations rather than one blended average: "met" and
 * "missed" are read side by side, because an average that mixes them tells a
 * supervisor the temperature of the room and nothing they can act on.
 *
 * The SLA target is a first-response threshold in minutes. It is a control here
 * rather than a hard-coded number so this page cannot silently disagree with
 * whatever the SLA policies say; wiring it to sla_policies is the follow-up.
 */
const DEFAULT_TARGET_MIN = 5;

type View = 'met' | 'missed';

export function AgentPerformancePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

  const timings = useChatTimings(filters, agentNames);
  const chats = useMemo<ChatTiming[]>(() => timings.data ?? [], [timings.data]);

  const { met, missed } = useMemo(() => splitBySla(chats, targetMin * 60), [chats, targetMin]);
  const population = view === 'met' ? met : missed;
  const rows = useMemo(() => agentPerformance(population), [population]);

  // Chats behind the CURRENT view, so clicking a row opens work the number
  // actually describes rather than the agent's whole queue.
  const openFirstChatFor = (agentId: string | null) => {
    const hit = population.find((c) => c.agentId === agentId);
    if (hit) navigate(`/?conv=${encodeURIComponent(hit.conversationId)}`);
  };

  const dash = <span className="text-muted-foreground/50">—</span>;

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

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {timings.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {t('performance.empty', { defaultValue: 'No chats match these filters.' })}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-2xl bg-card shadow-soft">
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
                  <tr
                    key={r.agentId ?? 'unassigned'}
                    onClick={() => openFirstChatFor(r.agentId)}
                    className="cursor-pointer border-t border-border/60 transition-colors duration-fast hover:bg-secondary/50"
                  >
                    <td className="px-3 py-2.5 font-medium text-foreground">{r.agentName}</td>
                    <td className="px-3 py-2.5 text-end tabular-nums">{r.chats}</td>
                    <td
                      className={cn(
                        'px-3 py-2.5 text-end tabular-nums',
                        // Never blended into the averages, and never invisible:
                        // a non-zero here says the averages describe only part
                        // of this agent's work.
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
        <p className="px-1 pt-3 text-2xs leading-relaxed text-muted-foreground">
          {t('performance.basis', {
            defaultValue:
              'First response is measured from the customer’s first message to the first agent reply. Internal notes do not count as a reply. Chats nobody answered are counted under "No reply" and left out of the averages.',
          })}
        </p>
      </div>
    </div>
  );
}
