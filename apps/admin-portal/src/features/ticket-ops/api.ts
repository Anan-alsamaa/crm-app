import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * Ticket operations report — a lifecycle/backlog view of tickets, computed
 * client-side from the collections the admin can already read (same approach as
 * the dashboard + SLA reports, so it filters live with no worker round-trip).
 *
 * Where the SLA report answers "are we hitting our SLAs?", this answers the
 * operational questions a support lead asks day to day:
 *   - How big is the backlog, and how much of it is overdue or unassigned?
 *   - How fast do we respond and resolve (median lifecycle times)?
 *   - How is load distributed across agents (who's carrying the open work)?
 *   - The full ticket register with every lifecycle timestamp, exportable.
 */

export type LifecycleStatus = 'new' | 'open' | 'pending' | 'resolved' | 'closed';

export interface TicketOpsRow {
  id: string;
  subject: string;
  status: string;
  priority: string;
  agentId: string | null;
  agentName: string;
  teamName: string;
  created: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Minutes from creation → first response (null until responded). */
  responseMinutes: number | null;
  /** Minutes from creation → resolution (null until resolved). */
  resolutionMinutes: number | null;
  /** Resolution deadline passed and the ticket is not yet resolved/closed. */
  overdue: boolean;
  /** Hours the ticket has been open (creation → now); null once resolved/closed. */
  ageHours: number | null;
  /** Contact name (for the register + order lookup). */
  contactName: string;
  /** Commerce identifiers so a row can lazily load the linked Yiji order. */
  customerId: string | null;
  yijiVendorId: string | null;
}

export interface AgentLoad {
  agentId: string | null;
  agentName: string;
  total: number;
  open: number;
  overdue: number;
  resolved: number;
  avgResolutionMin: number | null;
}

export interface TicketOps {
  rows: TicketOpsRow[];
  totals: {
    total: number;
    open: number; // new + open + pending (live backlog)
    pending: number;
    resolved: number;
    closed: number;
    overdue: number;
    unassigned: number; // open backlog with no assigned agent
  };
  byStatus: Array<{ key: string; count: number }>;
  byPriority: Array<{ key: string; count: number }>;
  timing: {
    medianResponseMin: number | null;
    medianResolutionMin: number | null;
    avgResolutionMin: number | null;
  };
  agents: AgentLoad[];
}

interface RawTicket {
  id: string;
  subject: string | null;
  status: string;
  priority: string;
  assigned_agent: string | null;
  assigned_team: string | null;
  date_created: string | null;
  first_responded_at: string | null;
  resolution_due_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  contact: {
    id: string;
    name: string | null;
    external_customer_id: string | null;
    vendor: { yiji_vendor_id: string | null } | null;
  } | null;
}

const OPEN_STATES = new Set(['new', 'open', 'pending']);
const DONE_STATES = new Set(['resolved', 'closed']);

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
}

export function useTicketOps(days: number) {
  return useQuery({
    queryKey: ['ticket-ops', days],
    staleTime: 60_000,
    queryFn: async (): Promise<TicketOps> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const now = Date.now();

      const [tickets, users, teams] = await Promise.all([
        directus.request(
          readItems('tickets', {
            filter: { date_created: { _gte: since } },
            fields: [
              'id',
              'subject',
              'status',
              'priority',
              'assigned_agent',
              'assigned_team',
              'date_created',
              'first_responded_at',
              'resolution_due_at',
              'resolved_at',
              'closed_at',
              { contact: ['id', 'name', 'external_customer_id', { vendor: ['yiji_vendor_id'] }] },
            ],
            limit: -1,
            sort: ['-date_created'],
          }),
        ) as Promise<RawTicket[]>,
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<
          Array<{
            id: string;
            first_name: string | null;
            last_name: string | null;
            email: string | null;
          }>
        >,
        directus.request(readItems('teams', { fields: ['id', 'name'], limit: -1 })) as Promise<
          Array<{ id: string; name: string | null }>
        >,
      ]);

      const userName = new Map(
        users.map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—',
        ]),
      );
      const teamName = new Map(teams.map((tm) => [tm.id, tm.name || '—']));

      const rows: TicketOpsRow[] = tickets.map((t) => {
        const isDone = DONE_STATES.has(t.status);
        const overdue =
          !isDone && !!t.resolution_due_at && new Date(t.resolution_due_at).getTime() < now;
        return {
          id: t.id,
          subject: t.subject || '(no subject)',
          status: t.status,
          priority: t.priority,
          agentId: t.assigned_agent,
          agentName: t.assigned_agent ? (userName.get(t.assigned_agent) ?? '—') : 'Unassigned',
          teamName: t.assigned_team ? (teamName.get(t.assigned_team) ?? '—') : '—',
          created: t.date_created,
          firstRespondedAt: t.first_responded_at,
          resolvedAt: t.resolved_at,
          closedAt: t.closed_at,
          responseMinutes: minutesBetween(t.date_created, t.first_responded_at),
          resolutionMinutes: minutesBetween(t.date_created, t.resolved_at),
          overdue,
          ageHours:
            !isDone && t.date_created
              ? (now - new Date(t.date_created).getTime()) / 3_600_000
              : null,
          contactName: t.contact?.name ?? '—',
          customerId: t.contact?.external_customer_id ?? null,
          yijiVendorId: t.contact?.vendor?.yiji_vendor_id ?? null,
        };
      });

      // Totals + breakdowns.
      const byStatusMap = new Map<string, number>();
      const byPriorityMap = new Map<string, number>();
      let open = 0;
      let pending = 0;
      let resolved = 0;
      let closed = 0;
      let overdue = 0;
      let unassigned = 0;
      const resolutionMins: number[] = [];
      const responseMins: number[] = [];

      for (const r of rows) {
        byStatusMap.set(r.status, (byStatusMap.get(r.status) ?? 0) + 1);
        byPriorityMap.set(r.priority, (byPriorityMap.get(r.priority) ?? 0) + 1);
        if (OPEN_STATES.has(r.status)) {
          open += 1;
          if (r.status === 'pending') pending += 1;
          if (!r.agentId) unassigned += 1;
        }
        if (r.status === 'resolved') resolved += 1;
        if (r.status === 'closed') closed += 1;
        if (r.overdue) overdue += 1;
        if (r.resolutionMinutes != null) resolutionMins.push(r.resolutionMinutes);
        if (r.responseMinutes != null) responseMins.push(r.responseMinutes);
      }

      // Per-agent load (open + overdue backlog, throughput, avg resolution time).
      const loadMap = new Map<string, AgentLoad & { _resMins: number[] }>();
      for (const r of rows) {
        const key = r.agentId ?? '__unassigned__';
        let a = loadMap.get(key);
        if (!a) {
          a = {
            agentId: r.agentId,
            agentName: r.agentName,
            total: 0,
            open: 0,
            overdue: 0,
            resolved: 0,
            avgResolutionMin: null,
            _resMins: [],
          };
          loadMap.set(key, a);
        }
        a.total += 1;
        if (OPEN_STATES.has(r.status)) a.open += 1;
        if (r.overdue) a.overdue += 1;
        if (DONE_STATES.has(r.status)) a.resolved += 1;
        if (r.resolutionMinutes != null) a._resMins.push(r.resolutionMinutes);
      }
      const agents: AgentLoad[] = Array.from(loadMap.values())
        .map(({ _resMins, ...a }) => ({
          ...a,
          avgResolutionMin: _resMins.length
            ? _resMins.reduce((s, n) => s + n, 0) / _resMins.length
            : null,
        }))
        .sort((a, b) => b.overdue - a.overdue || b.open - a.open || b.total - a.total);

      const order = ['new', 'open', 'pending', 'resolved', 'closed'];
      const prioOrder = ['urgent', 'high', 'medium', 'low'];
      const byStatus = Array.from(byStatusMap.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      const byPriority = Array.from(byPriorityMap.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => prioOrder.indexOf(a.key) - prioOrder.indexOf(b.key));

      return {
        rows,
        totals: { total: rows.length, open, pending, resolved, closed, overdue, unassigned },
        byStatus,
        byPriority,
        timing: {
          medianResponseMin: median(responseMins),
          medianResolutionMin: median(resolutionMins),
          avgResolutionMin: resolutionMins.length
            ? resolutionMins.reduce((s, n) => s + n, 0) / resolutionMins.length
            : null,
        },
        agents,
      };
    },
  });
}
