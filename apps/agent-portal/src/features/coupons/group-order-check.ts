import { useQuery } from '@tanstack/react-query';
import { readItem, readItems } from '@directus/sdk';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';

/**
 * GROUP ORDERS IN THE COUPON DIALOG (owner, 2026-11-11): one coupon per group
 * order, linked to the MASTER, its restaurants getting equal shares.
 *
 * The agent is told before sending: the coupon goes on the group order, and if
 * that group order already has a coupon the request is blocked, naming it. The
 * coupon worker enforces the same rule again when it sends to Yiji - this is the
 * early warning, so a failed read here never blocks anything.
 */
export interface GroupOrderCheck {
  /** The master order the coupon will be linked to. */
  masterId: string;
  /** The order number the coupon was raised on. */
  enteredId: string;
  /** A coupon that already covers this group order, if any. */
  coveredBy: { id: string; code: string | null; status: string | null } | null;
}

export function useGroupOrderCheck(args: {
  open: boolean;
  ticketId?: string | null;
  orderId?: string | null;
  vendorId?: string | null;
  /** The coupon being edited or replaced - it does not count as another. */
  excludeId?: string | null;
}) {
  const { open, ticketId, orderId, vendorId, excludeId } = args;
  return useQuery({
    queryKey: [
      'coupon-group-check',
      ticketId ?? null,
      orderId ?? null,
      vendorId ?? null,
      excludeId ?? null,
    ],
    enabled: open && !!(ticketId || orderId),
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<GroupOrderCheck | null> => {
      let order = orderId?.trim() || null;
      let vendor = vendorId ?? null;
      if (ticketId) {
        const tk = (await directus.request(
          readItem('tickets' as never, ticketId, { fields: ['order_id', 'vendor'] } as never),
        )) as unknown as { order_id?: string | null; vendor?: string | null } | null;
        order = tk?.order_id?.trim() || order;
        vendor = vendor ?? tk?.vendor ?? null;
      }
      if (!order || !/^\d+$/.test(order) || !vendor) return null;
      const detail = await commerce.getOrder(vendor, order);
      if (!detail?.groupRole || !detail.groupMasterId) return null;
      const masterId = detail.groupMasterId;
      const ids = [...new Set([masterId, order])];
      const others = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: ['id', 'coupon_code', 'status'],
            filter: {
              _and: [
                ...(excludeId ? [{ id: { _neq: excludeId } }] : []),
                { status: { _in: ['pending', 'approved', 'assigned'] } },
                { replaced_by: { _null: true } },
                {
                  _or: [
                    { group_order_id: { _eq: masterId } },
                    { order_id: { _in: ids } },
                    { ticket: { order_id: { _in: ids } } },
                  ],
                },
              ],
            },
            sort: ['date_created'],
            limit: 1,
          } as never,
        ),
      )) as unknown as Array<{ id: string; coupon_code?: string | null; status?: string | null }>;
      const first = others?.[0];
      return {
        masterId,
        enteredId: order,
        coveredBy: first
          ? { id: first.id, code: first.coupon_code ?? null, status: first.status ?? null }
          : null,
      };
    },
  });
}
