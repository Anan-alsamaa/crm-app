import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { buildStoreIndex, matchStore } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * The operations manager's complaint dashboard, computed over our tickets.
 *
 * Modelled directly on the Dashboard screen of the app this replaces: the same
 * filter bar (date range + brand / city / restaurant), the same six KPIs, the
 * same complaints-per-month trend, the same breakdowns, and the same agent
 * performance table. Where his data and ours genuinely differ the metric is
 * renamed to what it actually measures rather than kept and quietly redefined —
 * see `satisfiedPct` and `overdue` below.
 *
 * Aggregated client-side like the rest of the overview: this reads collections
 * the admin can already see, and keeping it in the browser means no worker
 * round-trip and no second source of truth for numbers the ops team check daily.
 */

export interface ComplaintFilters {
  /** `yyyy-mm-dd`; empty means unbounded. */
  from: string;
  to: string;
  /** Brand id, city name, store id. Empty means "all". */
  brand: string;
  city: string;
  store: string;
}

export const emptyComplaintFilters: ComplaintFilters = {
  from: '',
  to: '',
  brand: '',
  city: '',
  store: '',
};

/** One row of a "By X" breakdown, already sorted and capped. */
export interface Breakdown {
  key: string;
  label: string;
  count: number;
}

export interface AgentPerformance {
  id: string;
  name: string;
  logged: number;
  solved: number;
  solvedPct: number | null;
  /** Mean hours from raised to closed, over the ones actually closed. */
  avgHoursToClose: number | null;
  compensation: number;
  /** Still not closed — what a supervisor chases. */
  open: number;
}

export interface MonthPoint {
  /** `yyyy-mm`. */
  month: string;
  count: number;
  compensation: number;
}

export interface ComplaintMetrics {
  total: number;
  monthsCovered: number;
  open: number;
  overdue: number;
  closed: number;
  /** Closed tickets whose conversation came back with a CSAT score. */
  rated: number;
  satisfied: number;
  satisfiedPct: number | null;
  compensation: number;
  avgCompensation: number | null;
  chatsWaiting: number;
  chatsTotal: number;

  months: MonthPoint[];
  byRestaurant: Breakdown[];
  byType: Breakdown[];
  byBrand: Breakdown[];
  byCity: Breakdown[];
  byStatus: Breakdown[];
  byServiceType: Breakdown[];
  bySource: Breakdown[];
  agents: AgentPerformance[];

  /** Options for the filter bar, derived from the store master. */
  brandOptions: Array<{ id: string; name: string }>;
  cityOptions: string[];
  storeOptions: Array<{ id: string; name: string; city: string | null }>;

  /** Tickets with no branch resolved at all — the honest gap in every by-branch cut. */
  unattributed: number;
}

/** Statuses that mean "still being worked". */
const OPEN_STATUSES = new Set(['new', 'open', 'pending']);
const CLOSED_STATUSES = new Set(['resolved', 'closed']);

interface TicketRecord {
  id: string;
  status: string;
  date_created: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  assigned_agent: string | null;
  conversation: string | null;
  store: string | null;
  complaint_type: string | null;
  service_type: string | null;
  complaint_source: string | null;
  compensation: string | null;
  coupon_value: number | null;
  order_snapshot: {
    brandName?: string | null;
    restaurantName?: string | null;
    restaurantId?: string | null;
  } | null;
}

interface StoreRecordRow {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  brand: { id: string; code: string; name: string; yiji_brand_name?: string | null } | null;
}

/** Sort a count map into his "biggest first, top N" bar list. */
function topN(counts: Map<string, number>, n: number): Breakdown[] {
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, n);
}

const bump = (m: Map<string, number>, key: string | null | undefined) => {
  const k = (key ?? '').trim();
  if (k) m.set(k, (m.get(k) ?? 0) + 1);
};

export function useComplaintMetrics(filters: ComplaintFilters) {
  return useQuery({
    queryKey: ['complaint-metrics', filters],
    staleTime: 60_000,
    queryFn: async (): Promise<ComplaintMetrics> => {
      // Date bounds go to the server; everything else needs the store join to
      // evaluate, so it is applied below once each ticket has a branch.
      const dateFilter: Record<string, unknown> = {};
      if (filters.from) dateFilter._gte = `${filters.from}T00:00:00`;
      // Inclusive `to`: a range ending on the 31st must contain the 31st.
      if (filters.to) dateFilter._lte = `${filters.to}T23:59:59`;

      const [tickets, storeRows, users, csat, conversations] = await Promise.all([
        directus.request(
          readItems('tickets', {
            ...(filters.from || filters.to ? { filter: { date_created: dateFilter } } : {}),
            fields: [
              'id',
              'status',
              'date_created',
              'resolved_at',
              'closed_at',
              'first_responded_at',
              'first_response_due_at',
              'assigned_agent',
              'conversation',
              'store',
              'complaint_type',
              'service_type',
              'complaint_source',
              'compensation',
              'coupon_value',
              'order_snapshot',
            ],
            limit: -1,
          }),
        ) as Promise<TicketRecord[]>,
        directus.request(
          readItems('stores', {
            fields: [
              'id',
              'code',
              'name',
              'city',
              'area_manager',
              'chain_manager',
              'yiji_restaurant_id',
              'brand.id',
              'brand.code',
              'brand.name',
              'brand.yiji_brand_name',
            ],
            limit: -1,
          }),
        ) as Promise<StoreRecordRow[]>,
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
        // CSAT hangs off the CONVERSATION, not the ticket — so satisfaction can
        // only be known for complaints that came out of a chat. That is why the
        // satisfied % below reports its own denominator instead of pretending
        // to cover every closed complaint.
        directus.request(
          readItems('csat_responses', {
            fields: ['id', 'score', 'conversation'],
            limit: -1,
          }),
        ) as Promise<Array<{ id: string; score: number | null; conversation: string | null }>>,
        directus.request(
          readItems('conversations', { fields: ['id', 'status'], limit: -1 }),
        ) as Promise<Array<{ id: string; status: string }>>,
      ]);

      const storeById = new Map(storeRows.map((s) => [s.id, s]));
      const storeIndex = buildStoreIndex(
        storeRows.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          city: s.city,
          areaManager: s.area_manager,
          chainManager: s.chain_manager,
          brandCode: s.brand?.code ?? null,
          brandName: s.brand?.name ?? null,
          brandYijiName: s.brand?.yiji_brand_name ?? null,
          yijiRestaurantId: s.yiji_restaurant_id,
        })),
      );
      const userName = new Map(
        users.map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—',
        ]),
      );
      // Best score per conversation; a customer can only really answer once, but
      // a duplicate must not double-count the complaint it belongs to.
      const scoreByConversation = new Map<string, number>();
      for (const r of csat) {
        if (r.conversation && typeof r.score === 'number') {
          scoreByConversation.set(r.conversation, r.score);
        }
      }

      /* Resolve each ticket to a branch, then apply the branch-dependent
       * filters. `tickets.store` is authoritative — an agent chose it. Only when
       * it is absent do we fall back to matching the order snapshot, which is
       * how every ticket raised before the branch field existed still counts. */
      type Row = TicketRecord & {
        storeId: string | null;
        restaurantName: string;
        brandId: string | null;
        brandName: string;
        city: string;
      };
      const rows: Row[] = [];
      let unattributed = 0;

      for (const tk of tickets) {
        let storeId: string | null = null;
        let restaurantName = '';
        let brandId: string | null = null;
        let brandName = '';
        let city = '';

        const direct = tk.store ? storeById.get(tk.store) : undefined;
        if (direct) {
          storeId = direct.id;
          restaurantName = [direct.code, direct.name].filter(Boolean).join(' ');
          brandId = direct.brand?.id ?? null;
          brandName = direct.brand?.name ?? '';
          city = direct.city ?? '';
        } else if (tk.order_snapshot) {
          const m = matchStore(storeIndex, {
            restaurantId: tk.order_snapshot.restaurantId ?? undefined,
            restaurantName: tk.order_snapshot.restaurantName ?? undefined,
            brandName: tk.order_snapshot.brandName ?? undefined,
          });
          if (m.store) {
            storeId = m.store.id;
            restaurantName = [m.store.code, m.store.name].filter(Boolean).join(' ');
            brandId = storeById.get(m.store.id)?.brand?.id ?? null;
            city = m.city;
          } else {
            // Keep the order's own wording so the branch is at least named.
            restaurantName = m.restaurantName || (tk.order_snapshot.restaurantName ?? '');
            city = m.city;
          }
          brandName = m.brandName || brandName;
        }
        if (!storeId && !restaurantName) unattributed += 1;

        if (filters.brand && brandId !== filters.brand) continue;
        if (filters.city && city !== filters.city) continue;
        if (filters.store && storeId !== filters.store) continue;

        rows.push({ ...tk, storeId, restaurantName, brandId, brandName, city });
      }

      // ── KPIs ────────────────────────────────────────────────────────────
      const now = Date.now();
      let open = 0;
      let overdue = 0;
      let closed = 0;
      let rated = 0;
      let satisfied = 0;
      let compensation = 0;
      const monthMap = new Map<string, MonthPoint>();

      const byRestaurant = new Map<string, number>();
      const byType = new Map<string, number>();
      const byBrand = new Map<string, number>();
      const byCity = new Map<string, number>();
      const byStatus = new Map<string, number>();
      const byServiceType = new Map<string, number>();
      const bySource = new Map<string, number>();

      const agentAgg = new Map<
        string,
        { logged: number; solved: number; open: number; hours: number[]; money: number }
      >();

      for (const r of rows) {
        const money = typeof r.coupon_value === 'number' ? r.coupon_value : 0;
        compensation += money;

        if (OPEN_STATUSES.has(r.status)) open += 1;
        if (CLOSED_STATUSES.has(r.status)) {
          closed += 1;
          // Satisfaction is the customer's answer on the linked chat, not a
          // status an agent set — so it exists only for some closed complaints.
          const score = r.conversation ? scoreByConversation.get(r.conversation) : undefined;
          if (typeof score === 'number') {
            rated += 1;
            if (score >= 4) satisfied += 1;
          }
        }
        // No "Escalated" status here, so the nearest true signal of a complaint
        // in trouble is one that blew its first-response SLA and still has not
        // been answered.
        if (
          !r.first_responded_at &&
          r.first_response_due_at &&
          new Date(r.first_response_due_at).getTime() < now
        ) {
          overdue += 1;
        }

        const month = (r.date_created ?? '').slice(0, 7);
        if (month) {
          const cur = monthMap.get(month) ?? { month, count: 0, compensation: 0 };
          cur.count += 1;
          cur.compensation += money;
          monthMap.set(month, cur);
        }

        bump(byRestaurant, r.restaurantName);
        bump(byType, r.complaint_type);
        bump(byBrand, r.brandName);
        bump(byCity, r.city);
        bump(byStatus, r.status);
        bump(byServiceType, r.service_type);
        bump(bySource, r.complaint_source);

        const agentId = r.assigned_agent ?? '';
        const a = agentAgg.get(agentId) ?? {
          logged: 0,
          solved: 0,
          open: 0,
          hours: [],
          money: 0,
        };
        a.logged += 1;
        a.money += money;
        if (CLOSED_STATUSES.has(r.status)) {
          a.solved += 1;
          const end = r.closed_at ?? r.resolved_at;
          if (r.date_created && end) {
            const h = (new Date(end).getTime() - new Date(r.date_created).getTime()) / 3_600_000;
            if (Number.isFinite(h) && h >= 0) a.hours.push(h);
          }
        } else {
          a.open += 1;
        }
        agentAgg.set(agentId, a);
      }

      const agents: AgentPerformance[] = Array.from(agentAgg.entries())
        .map(([id, a]) => ({
          id,
          name: id ? (userName.get(id) ?? id) : 'Unassigned',
          logged: a.logged,
          solved: a.solved,
          solvedPct: a.logged ? (a.solved / a.logged) * 100 : null,
          avgHoursToClose: a.hours.length
            ? a.hours.reduce((x, y) => x + y, 0) / a.hours.length
            : null,
          compensation: a.money,
          open: a.open,
        }))
        .sort((x, y) => y.logged - x.logged);

      const months = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));

      const brandOptions = Array.from(
        new Map(
          storeRows
            .filter((s) => s.brand)
            .map((s) => [s.brand!.id, { id: s.brand!.id, name: s.brand!.name }]),
        ).values(),
      ).sort((a, b) => a.name.localeCompare(b.name));

      const cityOptions = Array.from(
        new Set(storeRows.map((s) => (s.city ?? '').trim()).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));

      const storeOptions = storeRows
        .map((s) => ({
          id: s.id,
          name: [s.code, s.name].filter(Boolean).join(' '),
          city: s.city,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const conversationsWaiting = conversations.filter(
        (c) => c.status !== 'resolved' && c.status !== 'closed',
      ).length;

      return {
        total: rows.length,
        monthsCovered: months.length,
        open,
        overdue,
        closed,
        rated,
        satisfied,
        satisfiedPct: rated ? (satisfied / rated) * 100 : null,
        compensation,
        avgCompensation: rows.length ? compensation / rows.length : null,
        chatsWaiting: conversationsWaiting,
        chatsTotal: conversations.length,
        months,
        byRestaurant: topN(byRestaurant, 10),
        byType: topN(byType, 10),
        byBrand: topN(byBrand, 6),
        byCity: topN(byCity, 8),
        byStatus: topN(byStatus, 6),
        byServiceType: topN(byServiceType, 6),
        bySource: topN(bySource, 6),
        agents,
        brandOptions,
        cityOptions,
        storeOptions,
        unattributed,
      };
    },
  });
}
