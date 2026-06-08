import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * Live operational metrics for the admin overview (scope §16). Computed
 * client-side by aggregating the source collections the admin can already read,
 * scoped to a rolling date window. No worker round-trip — this is the at-a-glance
 * dashboard; the Reports feature still produces scheduled CSV exports.
 */

export interface DashboardMetrics {
  conversationVolume: number;
  conversationsByStatus: Record<string, number>;
  volumeSeries: Array<{ day: string; count: number }>;
  avgResponseMinutes: number | null;
  slaCompliancePct: number | null;
  ticketResolutionPct: number | null;
  ticketTotal: number;
  csatAvg: number | null;
  csatCount: number;
  topAgents: Array<{ id: string; name: string; resolved: number }>;
  topVendors: Array<{ id: string; name: string; conversations: number }>;
}

const minutesBetween = (a: string, b: string) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

export function useDashboardMetrics(days: number) {
  return useQuery({
    queryKey: ['dashboard-metrics', days],
    // Recompute on an interval so the overview stays roughly live.
    staleTime: 60_000,
    queryFn: async (): Promise<DashboardMetrics> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const dateFilter = { date_created: { _gte: since } };

      const [conversations, tickets, csat, users, vendors] = await Promise.all([
        directus.request(
          readItems('conversations', {
            filter: dateFilter,
            fields: ['id', 'status', 'date_created', 'vendor'],
            limit: -1,
          }),
        ) as Promise<Array<{ id: string; status: string; date_created: string | null; vendor: string | null }>>,
        directus.request(
          readItems('tickets', {
            filter: dateFilter,
            fields: [
              'id',
              'status',
              'date_created',
              'first_responded_at',
              'first_response_due_at',
              'assigned_agent',
            ],
            limit: -1,
          }),
        ) as Promise<
          Array<{
            id: string;
            status: string;
            date_created: string | null;
            first_responded_at: string | null;
            first_response_due_at: string | null;
            assigned_agent: string | null;
          }>
        >,
        directus.request(
          readItems('csat_responses', {
            filter: { submitted_at: { _gte: since } },
            fields: ['id', 'score'],
            limit: -1,
          }),
        ) as Promise<Array<{ id: string; score: number | null }>>,
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>>,
        directus.request(
          readItems('vendors', { fields: ['id', 'name'], limit: -1 }),
        ) as Promise<Array<{ id: string; name: string }>>,
      ]);

      const userName = new Map(
        users.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—']),
      );
      const vendorName = new Map(vendors.map((v) => [v.id, v.name]));

      // Conversations: volume, status breakdown, per-day series, per-vendor.
      const conversationsByStatus: Record<string, number> = {};
      const byDay = new Map<string, number>();
      const byVendor = new Map<string, number>();
      for (const c of conversations) {
        conversationsByStatus[c.status] = (conversationsByStatus[c.status] ?? 0) + 1;
        const day = (c.date_created ?? '').slice(0, 10);
        if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
        if (c.vendor) byVendor.set(c.vendor, (byVendor.get(c.vendor) ?? 0) + 1);
      }
      const volumeSeries = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ day, count }));
      const topVendors = Array.from(byVendor.entries())
        .map(([id, conversations]) => ({ id, name: vendorName.get(id) ?? id, conversations }))
        .sort((a, b) => b.conversations - a.conversations)
        .slice(0, 5);

      // Tickets: response time, SLA compliance, resolution rate, agent productivity.
      let respSum = 0;
      let respCount = 0;
      let slaEligible = 0;
      let slaOnTime = 0;
      let resolvedOrClosed = 0;
      const byAgent = new Map<string, number>();
      for (const tk of tickets) {
        if (tk.date_created && tk.first_responded_at) {
          respSum += minutesBetween(tk.date_created, tk.first_responded_at);
          respCount += 1;
        }
        if (tk.first_response_due_at) {
          slaEligible += 1;
          if (tk.first_responded_at && new Date(tk.first_responded_at) <= new Date(tk.first_response_due_at))
            slaOnTime += 1;
        }
        if (tk.status === 'resolved' || tk.status === 'closed') {
          resolvedOrClosed += 1;
          if (tk.assigned_agent) byAgent.set(tk.assigned_agent, (byAgent.get(tk.assigned_agent) ?? 0) + 1);
        }
      }
      const topAgents = Array.from(byAgent.entries())
        .map(([id, resolved]) => ({ id, name: userName.get(id) ?? id, resolved }))
        .sort((a, b) => b.resolved - a.resolved)
        .slice(0, 5);

      const csatScores = csat.map((r) => r.score).filter((s): s is number => typeof s === 'number');

      return {
        conversationVolume: conversations.length,
        conversationsByStatus,
        volumeSeries,
        avgResponseMinutes: respCount ? respSum / respCount : null,
        slaCompliancePct: slaEligible ? (slaOnTime / slaEligible) * 100 : null,
        ticketResolutionPct: tickets.length ? (resolvedOrClosed / tickets.length) * 100 : null,
        ticketTotal: tickets.length,
        csatAvg: csatScores.length ? csatScores.reduce((a, b) => a + b, 0) / csatScores.length : null,
        csatCount: csatScores.length,
        topAgents,
        topVendors,
      };
    },
  });
}
