import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * WHO LAST CORRECTED A PENDING REQUEST, AND WHEN (owner, 2026-10-26).
 *
 * An agent may correct their own request while it is still pending (the
 * agent portal's Edit). No column records a correction as such and the owner
 * asked for no new schema, so this reads Directus's own `user_updated` /
 * `date_updated` stamps under one rule: a pending request whose LAST write was
 * made by the agent who RAISED it was corrected by them. Creating a row leaves
 * both stamps empty, the workers write as a service account, and a
 * supervisor's Save or withhold stamps the supervisor — none of which reads as
 * an agent's correction.
 *
 * A SEPARATE read rather than two more fields on the queue's query: the queue
 * must never fail over a decoration, and a field a role cannot read 403s the
 * whole query it is named in. Here a refusal only hides the marks. Keyed under
 * `coupon-approvals`, so every save that refreshes the queue refreshes this.
 */
export interface CorrectionStamp {
  userId: string;
  at: string;
}

export function useCorrectionStamps() {
  return useQuery({
    queryKey: ['coupon-approvals', 'correction-stamps'],
    retry: false,
    refetchInterval: 30_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: ['id', 'user_updated', 'date_updated'],
            filter: { status: { _eq: 'pending' }, date_updated: { _nnull: true } },
            limit: -1,
          } as never,
        ),
      )) as unknown as Array<{
        id: string;
        user_updated: string | { id: string } | null;
        date_updated: string | null;
      }>;
      const out = new Map<string, CorrectionStamp>();
      for (const r of rows) {
        const userId = typeof r.user_updated === 'string' ? r.user_updated : r.user_updated?.id;
        if (userId && r.date_updated) out.set(r.id, { userId, at: r.date_updated });
      }
      return out;
    },
  });
}

/** The stamp, only when it is the requester's own correction of a pending row. */
export function correctionOf(
  row: { id: string; status: string; requested_by: { id: string } | null },
  stamps: Map<string, CorrectionStamp> | undefined,
): CorrectionStamp | null {
  if (row.status !== 'pending') return null;
  const s = stamps?.get(row.id);
  return s && row.requested_by?.id && s.userId === row.requested_by.id ? s : null;
}
