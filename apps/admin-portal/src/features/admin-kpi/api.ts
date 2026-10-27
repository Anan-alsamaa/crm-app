import { useQuery } from '@tanstack/react-query';
import { aggregate, readItems, readUsers } from '@directus/sdk';
import { YIJI_GUARD_BREAKER_OPERATION } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import {
  aiSummary,
  chatSummary,
  couponSummary,
  lateOrderSummary,
  ticketSummary,
  totalOf,
  countsBy,
  yijiDailyTrend,
  yijiOperations,
  yijiUsageTotals,
  windowDays,
  type GroupRow,
} from './admin-kpi.js';

/**
 * ADMIN KPI - the reads (owner, 2026-10-21).
 *
 * One query per block, so one collection that cannot be read (a field not yet
 * bootstrapped, say) shows ITS block's error and nothing else's. Everything is
 * read with the owner's own token: the page is owner-only, and the owner reads
 * every collection through admin_access - `yiji_api_usage` and `ai_calls` are
 * readable by nobody else.
 *
 * Counts are grouped server-side (`aggregate`), never downloaded and counted;
 * the only row reads are small column lists (first-response stamps, late-order
 * decisions, the recent Yiji errors), and no filter carries a list of ids.
 */

type Window = { fromIso: string; toIso: string };
const STALE = 60_000;

const inWindow = (w: Window, field = 'date_created') => ({
  [field]: { _between: [w.fromIso, w.toIso] },
});
const and = (...parts: object[]) => ({ _and: parts });

function count(collection: string, filter: object, groupBy?: string[]): Promise<GroupRow[]> {
  return directus.request(
    aggregate(
      collection as never,
      {
        aggregate: { count: '*' },
        ...(groupBy ? { groupBy } : {}),
        query: { filter, limit: -1 },
      } as never,
    ),
  ) as unknown as Promise<GroupRow[]>;
}

function rows<T>(collection: string, query: object): Promise<T[]> {
  return directus.request(readItems(collection as never, query as never)) as unknown as Promise<
    T[]
  >;
}

const key = (block: string, w: Window) => ['admin-kpi', block, w.fromIso, w.toIso] as const;

export function useChatsKpi(w: Window) {
  return useQuery({
    queryKey: key('chats', w),
    staleTime: STALE,
    queryFn: async () => {
      const [byStatus, responded] = await Promise.all([
        count('conversations', inWindow(w), ['status']),
        rows<{ date_created: string; first_responded_at: string }>('conversations', {
          fields: ['date_created', 'first_responded_at'],
          filter: and(inWindow(w), { first_responded_at: { _nnull: true } }),
          limit: -1,
        }),
      ]);
      return chatSummary(byStatus, responded);
    },
  });
}

export function useTicketsKpi(w: Window) {
  return useQuery({
    queryKey: key('tickets', w),
    staleTime: STALE,
    queryFn: async () => {
      const [byStatus, byCompensation] = await Promise.all([
        count('tickets', inWindow(w), ['status']),
        count('tickets', inWindow(w), ['compensation']),
      ]);
      return ticketSummary(byStatus, byCompensation);
    },
  });
}

export function useCouponsKpi(w: Window) {
  return useQuery({
    queryKey: key('coupons', w),
    staleTime: STALE,
    queryFn: async () => {
      const win = inWindow(w);
      const [byStatus, pushed, pushFailures, withheld, byRemoval] = await Promise.all([
        count('coupon_approvals', win, ['status']),
        count('coupon_approvals', and(win, { yiji_pushed_at: { _nnull: true } })),
        /* A push error on a coupon that never reached the customer's app. */
        count(
          'coupon_approvals',
          and(win, { yiji_push_error: { _nnull: true } }, { yiji_coupon_user_id: { _null: true } }),
        ),
        count('coupon_approvals', and(win, { delivery_excluded: { _eq: true } })),
        count('coupon_approvals', and(win, { removal_status: { _nnull: true } }), [
          'removal_status',
        ]),
      ]);
      /* EDITED coupons (owner, 2026-10-27): the replaced row and an abandoned
         edit are left out of every figure. Its OWN read - the fields need a
         manual apply:fields, and a missing field must cost only this. */
      const superseded = await count(
        'coupon_approvals',
        and(win, {
          _or: [
            { replaced_by: { _nnull: true } },
            { _and: [{ replaces: { _nnull: true } }, { status: { _eq: 'rejected' } }] },
          ],
        }),
        ['status'],
      ).catch(() => null);
      return couponSummary({ byStatus, pushed, pushFailures, withheld, byRemoval, superseded });
    },
  });
}

export function useLateOrdersKpi(w: Window) {
  return useQuery({
    queryKey: key('late-orders', w),
    staleTime: STALE,
    queryFn: async () =>
      lateOrderSummary(
        await rows<{ order_id: string; action: string; date_created: string }>(
          'late_order_decisions',
          { fields: ['order_id', 'action', 'date_created'], filter: inWindow(w), limit: -1 },
        ),
      ),
  });
}

export interface PeopleKpi {
  active: number;
  suspended: number;
  byRole: Array<{ role: string; count: number }>;
  busyNow: number;
}

/** Not dated: who exists now. Service accounts (svc-*) are not people. */
export function usePeopleKpi() {
  return useQuery({
    queryKey: ['admin-kpi', 'people'],
    staleTime: STALE,
    queryFn: async (): Promise<PeopleKpi> => {
      const [users, busy] = await Promise.all([
        directus.request(
          readUsers({ fields: ['id', 'status', { role: ['name'] }], limit: -1 } as never),
        ) as unknown as Promise<Array<{ status: string; role: { name: string } | null }>>,
        count('agent_busy_periods', { ended_at: { _null: true } }),
      ]);
      const people = users.filter((u) => !(u.role?.name ?? '').toLowerCase().startsWith('svc-'));
      const roles = new Map<string, number>();
      for (const u of people) {
        if (u.status !== 'active') continue;
        const r = u.role?.name ?? '—';
        roles.set(r, (roles.get(r) ?? 0) + 1);
      }
      return {
        active: people.filter((u) => u.status === 'active').length,
        suspended: people.filter((u) => u.status !== 'active').length,
        byRole: [...roles.entries()]
          .map(([role, n]) => ({ role, count: n }))
          .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
        busyNow: totalOf(busy),
      };
    },
  });
}

export function useNotificationsKpi(w: Window) {
  return useQuery({
    queryKey: key('notifications', w),
    staleTime: STALE,
    queryFn: async () => {
      const [byType, unread] = await Promise.all([
        count('notifications', inWindow(w), ['type']),
        count('notifications', and(inWindow(w), { read_at: { _null: true } })),
      ]);
      const types = countsBy(byType, 'type');
      return {
        total: Object.values(types).reduce((x, y) => x + y, 0),
        unread: totalOf(unread),
        byType: Object.entries(types)
          .map(([type, n]) => ({ type, count: n }))
          .sort((a, b) => b.count - a.count),
      };
    },
  });
}

export function useAiKpi(w: Window) {
  return useQuery({
    queryKey: key('ai', w),
    staleTime: STALE,
    queryFn: async () =>
      aiSummary(
        (await directus.request(
          aggregate(
            'ai_calls' as never,
            {
              aggregate: {
                count: '*',
                sum: ['est_cost_usd', 'input_tokens', 'output_tokens', 'thinking_tokens'],
                avg: ['latency_ms'],
              },
              groupBy: ['status'],
              query: { filter: inWindow(w), limit: -1 },
            } as never,
          ),
        )) as unknown as GroupRow[],
      ),
  });
}

export interface YijiUsageEventRow {
  id: string | number;
  date_created: string;
  service: string;
  operation: string;
  account: 'crm' | 'backup';
  outcome: 'ok' | 'refused' | 'error';
  http_status: number | null;
  duration_ms: number | null;
  fallback_reason: string | null;
  error: string | null;
  vendor: string | null;
}

const USAGE_FIELDS = [
  'id',
  'date_created',
  'service',
  'operation',
  'account',
  'outcome',
  'http_status',
  'duration_ms',
  'fallback_reason',
  'error',
  'vendor',
];

/** How many problem rows the table holds - the newest; the counts above are exact. */
export const RECENT_USAGE_LIMIT = 500;

export function useYijiUsageKpi(w: Window) {
  return useQuery({
    queryKey: key('yiji-usage', w),
    staleTime: STALE,
    queryFn: async () => {
      const win = inWindow(w);
      /* Calls only: the outbound guard's own bookkeeping rows (`guard.*`, a
         breaker opening) are not calls to Yiji and are counted apart. */
      const calls = and(win, { operation: { _nstarts_with: 'guard.' } });
      const [byAccount, byOperation, byDay, lastBackup, recent, rateLimited, breakerOpens] =
        await Promise.all([
          count('yiji_api_usage', calls, ['account', 'outcome']),
          count('yiji_api_usage', calls, ['operation', 'account', 'outcome']),
          /* Calendar days (UTC), grouped by the server. A failure here (an older
           Directus without date functions in groupBy) costs the chart only. */
          count('yiji_api_usage', calls, [
            'year(date_created)',
            'month(date_created)',
            'day(date_created)',
            'account',
            'outcome',
          ]).catch(() => null),
          /* The backup's LAST use, whenever it was - not only in this window. */
          rows<YijiUsageEventRow>('yiji_api_usage', {
            fields: USAGE_FIELDS,
            filter: { account: { _eq: 'backup' } },
            sort: ['-date_created'],
            limit: 1,
          }),
          rows<YijiUsageEventRow>('yiji_api_usage', {
            fields: USAGE_FIELDS,
            filter: and(win, {
              _or: [{ outcome: { _neq: 'ok' } }, { account: { _eq: 'backup' } }],
            }),
            sort: ['-date_created'],
            limit: RECENT_USAGE_LIMIT,
          }),
          /* Yiji telling us to slow down (incident 2026-10-26): its 429s, and
           how often the guard's breaker paused non-urgent calls. */
          count('yiji_api_usage', and(calls, { http_status: { _eq: 429 } })),
          count('yiji_api_usage', and(win, { operation: { _eq: YIJI_GUARD_BREAKER_OPERATION } })),
        ]);
      const days = windowDays(w.fromIso, w.toIso);
      return {
        totals: yijiUsageTotals(byAccount),
        operations: yijiOperations(byOperation),
        trend: byDay ? yijiDailyTrend(byDay, days.from, days.to) : null,
        lastBackup: lastBackup[0] ?? null,
        recent,
        rateLimited: totalOf(rateLimited),
        breakerOpens: totalOf(breakerOpens),
      };
    },
  });
}
