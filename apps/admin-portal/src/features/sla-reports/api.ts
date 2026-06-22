import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * SLA reports — interactive, drill-down analytics over ticket SLA performance,
 * computed client-side from the collections the admin can already read (same
 * approach as the dashboard; no worker round-trip, so it filters live).
 *
 * Two cuts of the same data:
 *   - per AGENT  → compliance + breaches grouped by assigned agent (drill into
 *                  an agent to see their tickets), and
 *   - per TICKET → every ticket with its first-response + resolution SLA state.
 *
 * "Met vs breached" is judged from the ticket's own SLA timestamps:
 *   first response: first_responded_at  vs first_response_due_at
 *   resolution:     resolved_at          vs resolution_due_at
 */

export type SlaState = 'met' | 'breached' | 'pending' | 'na';

export interface SlaCell {
  state: SlaState;
  dueAt: string | null;
  doneAt: string | null;
}

export interface TicketSla {
  id: string;
  subject: string;
  priority: string;
  status: string;
  agentId: string | null;
  agentName: string;
  created: string | null;
  firstResponse: SlaCell;
  resolution: SlaCell;
  /** Minutes from creation to first response (null if not yet responded). */
  responseMinutes: number | null;
}

export interface AgentSla {
  agentId: string | null;
  agentName: string;
  tickets: number;
  frMet: number;
  frBreached: number;
  frPending: number;
  /** First-response compliance % over decided (met+breached) tickets. */
  frPct: number | null;
  resMet: number;
  resBreached: number;
  resPending: number;
  resPct: number | null;
  avgResponseMin: number | null;
  /** First-response + resolution breaches. */
  breaches: number;
}

export interface SlaReport {
  tickets: TicketSla[];
  agents: AgentSla[];
  totals: { tickets: number; frPct: number | null; resPct: number | null; breaches: number };
}

interface RawTicket {
  id: string;
  subject: string | null;
  status: string;
  priority: string;
  assigned_agent: string | null;
  date_created: string | null;
  first_response_due_at: string | null;
  first_responded_at: string | null;
  resolution_due_at: string | null;
  resolved_at: string | null;
}

/** Classify one SLA dimension: done-in-time / done-late / overdue / on-track / no-target. */
function classify(dueAt: string | null, doneAt: string | null, now: number): SlaCell {
  if (!dueAt) return { state: 'na', dueAt, doneAt };
  if (doneAt) {
    const met = new Date(doneAt).getTime() <= new Date(dueAt).getTime();
    return { state: met ? 'met' : 'breached', dueAt, doneAt };
  }
  return { state: new Date(dueAt).getTime() < now ? 'breached' : 'pending', dueAt, doneAt: null };
}

export function useSlaReports(days: number) {
  return useQuery({
    queryKey: ['sla-reports', days],
    staleTime: 60_000,
    queryFn: async (): Promise<SlaReport> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const now = Date.now();

      const [tickets, users] = await Promise.all([
        directus.request(
          readItems('tickets', {
            filter: { date_created: { _gte: since } },
            fields: [
              'id',
              'subject',
              'status',
              'priority',
              'assigned_agent',
              'date_created',
              'first_response_due_at',
              'first_responded_at',
              'resolution_due_at',
              'resolved_at',
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
      ]);

      const userName = new Map(
        users.map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—',
        ]),
      );

      const ticketSla: TicketSla[] = tickets.map((t) => ({
        id: t.id,
        subject: t.subject || '(no subject)',
        priority: t.priority,
        status: t.status,
        agentId: t.assigned_agent,
        agentName: t.assigned_agent ? (userName.get(t.assigned_agent) ?? '—') : 'Unassigned',
        created: t.date_created,
        firstResponse: classify(t.first_response_due_at, t.first_responded_at, now),
        resolution: classify(t.resolution_due_at, t.resolved_at, now),
        responseMinutes:
          t.date_created && t.first_responded_at
            ? (new Date(t.first_responded_at).getTime() - new Date(t.date_created).getTime()) /
              60_000
            : null,
      }));

      // Group per agent (unassigned tickets bucket under a single "Unassigned" row).
      const map = new Map<string, AgentSla>();
      const resp = new Map<string, { sum: number; count: number }>();
      for (const t of ticketSla) {
        const key = t.agentId ?? '__unassigned__';
        let a = map.get(key);
        if (!a) {
          a = {
            agentId: t.agentId,
            agentName: t.agentName,
            tickets: 0,
            frMet: 0,
            frBreached: 0,
            frPending: 0,
            frPct: null,
            resMet: 0,
            resBreached: 0,
            resPending: 0,
            resPct: null,
            avgResponseMin: null,
            breaches: 0,
          };
          map.set(key, a);
        }
        a.tickets += 1;
        if (t.firstResponse.state === 'met') a.frMet += 1;
        else if (t.firstResponse.state === 'breached') a.frBreached += 1;
        else if (t.firstResponse.state === 'pending') a.frPending += 1;
        if (t.resolution.state === 'met') a.resMet += 1;
        else if (t.resolution.state === 'breached') a.resBreached += 1;
        else if (t.resolution.state === 'pending') a.resPending += 1;
        if (t.responseMinutes != null) {
          const r = resp.get(key) ?? { sum: 0, count: 0 };
          r.sum += t.responseMinutes;
          r.count += 1;
          resp.set(key, r);
        }
      }

      const agents = Array.from(map.entries())
        .map(([key, a]) => {
          const frDecided = a.frMet + a.frBreached;
          const resDecided = a.resMet + a.resBreached;
          const r = resp.get(key);
          return {
            ...a,
            frPct: frDecided ? (a.frMet / frDecided) * 100 : null,
            resPct: resDecided ? (a.resMet / resDecided) * 100 : null,
            avgResponseMin: r && r.count ? r.sum / r.count : null,
            breaches: a.frBreached + a.resBreached,
          };
        })
        .sort((a, b) => b.breaches - a.breaches || b.tickets - a.tickets);

      let frMet = 0;
      let frBr = 0;
      let resMet = 0;
      let resBr = 0;
      let breaches = 0;
      for (const t of ticketSla) {
        if (t.firstResponse.state === 'met') frMet += 1;
        else if (t.firstResponse.state === 'breached') {
          frBr += 1;
          breaches += 1;
        }
        if (t.resolution.state === 'met') resMet += 1;
        else if (t.resolution.state === 'breached') {
          resBr += 1;
          breaches += 1;
        }
      }

      return {
        tickets: ticketSla,
        agents,
        totals: {
          tickets: ticketSla.length,
          frPct: frMet + frBr ? (frMet / (frMet + frBr)) * 100 : null,
          resPct: resMet + resBr ? (resMet / (resMet + resBr)) * 100 : null,
          breaches,
        },
      };
    },
  });
}
