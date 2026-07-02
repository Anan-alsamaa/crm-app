import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, triggerFlow } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * Compensation requests — the ops team works these through the agent portal
 * instead of Directus. Reads come straight from the cloned `compensation_requests`
 * collection; each workflow action is a Directus MANUAL flow triggered by id
 * (POST /flows/trigger/{id}). Flow ids are identical in local + prod (see
 * directus/compensation-clone/flow-contract.json), so this file is
 * environment-agnostic — it talks to whatever VITE_DIRECTUS_URL points at.
 * Directus stays the source of truth; the portal is just the trigger surface.
 */

export type CompensationStatus = 'Pending' | 'In Progress' | 'Approved' | 'Rejected';
export const COMPENSATION_STATUSES: CompensationStatus[] = [
  'Pending',
  'In Progress',
  'Approved',
  'Rejected',
];

export interface CompensationRow {
  id: string;
  request_code: string | null;
  status: CompensationStatus;
  customer_name: string | null;
  customer_mobile: string | null;
  customer_id: string | null;
  order_id: string | null;
  order_total: number | null;
  order_discount: number | null;
  order_points: number | null;
  delivery_fee: number | null;
  brand_name: string | null;
  restaurant_name: string | null;
  description: string | null;
  missing_items_text: string | null;
  user_complaint_amount: number | null;
  amount: number | null;
  suggested_compensation_value: string | null;
  final_compensation_value: number | null;
  coupon_code: string | null;
  decline_reason: string | null;
  inprogress_at: string | null;
  approved_at: string | null;
  declined_at: string | null;
  date_created: string | null;
  complaint_type: { id: string; name: string | null } | null;
  com_issue: { id: string; name: string | null } | null;
  coupons: { id: string; Code: string | null; Name: string | null } | null;
}

export interface CompensationItem {
  id: number;
  name: string | null;
  quantity: number | null;
  price: number | null;
}

const LIST_FIELDS = [
  'id',
  'request_code',
  'status',
  'customer_name',
  'customer_mobile',
  'order_id',
  'order_total',
  'brand_name',
  'restaurant_name',
  'user_complaint_amount',
  'suggested_compensation_value',
  'final_compensation_value',
  'date_created',
  { complaint_type: ['id', 'name'] },
] as const;

const DETAIL_FIELDS = [
  ...LIST_FIELDS,
  'customer_id',
  'order_discount',
  'order_points',
  'delivery_fee',
  'description',
  'missing_items_text',
  'amount',
  'coupon_code',
  'decline_reason',
  'inprogress_at',
  'approved_at',
  'declined_at',
  { com_issue: ['id', 'name'] },
  { coupons: ['id', 'Code', 'Name'] },
] as unknown as string[];

export function useCompensationRequests() {
  return useQuery({
    queryKey: ['compensation-requests'],
    queryFn: () =>
      directus.request(
        readItems('compensation_requests', {
          limit: -1,
          fields: LIST_FIELDS as unknown as string[],
          sort: ['-date_created'],
        }),
      ) as Promise<CompensationRow[]>,
  });
}

export function useCompensationRequest(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['compensation-request', id],
    queryFn: async () => {
      const rows = (await directus.request(
        readItems('compensation_requests', {
          filter: { id: { _eq: id } },
          fields: DETAIL_FIELDS,
          limit: 1,
        }),
      )) as CompensationRow[];
      return rows[0] ?? null;
    },
  });
}

export function useCompensationItems(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['compensation-items', id],
    queryFn: () =>
      directus.request(
        readItems('Compensation_Request_items', {
          filter: { compensation_request_id: { _eq: id } },
          fields: ['id', 'name', 'quantity', 'price'],
          limit: -1,
        }),
      ) as Promise<CompensationItem[]>,
  });
}

/**
 * Trigger a compensation workflow flow for one request. `inputs` carries any
 * flow-required fields (e.g. `reason`, or the coupon form). Directus runs the
 * flow server-side; we then refresh the request so the new status/fields show.
 */
export function useTriggerCompensationFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      flowId,
      requestId,
      inputs,
    }: {
      flowId: string;
      requestId: string;
      inputs?: Record<string, unknown>;
    }) =>
      // The SDK types the flow body as Record<string,string>, but the manual-flow
      // trigger accepts a JSON body (keys is an array) — cast to satisfy TS.
      directus.request(
        triggerFlow('POST', flowId, {
          collection: 'compensation_requests',
          keys: [requestId],
          ...(inputs ?? {}),
        } as unknown as Record<string, string>),
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['compensation-requests'] });
      void qc.invalidateQueries({ queryKey: ['compensation-request', vars.requestId] });
    },
  });
}
