import { createItem, createItems, deleteItems, readItems, updateItem } from '@directus/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarketingCouponDraft, MarketingCouponStatus } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { logActivity } from '../activity/api.js';

export interface MarketingCoupon extends MarketingCouponDraft {
  id: string;
  status: MarketingCouponStatus;
  brand_name: string | null;
  date_created: string;
  submitted_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  yiji_coupon_id: string | null;
  sent_at: string | null;
  send_error: string | null;
  user_created: { id: string; first_name: string | null; email: string | null } | null;
  recipient_count: number | null;
  sent_count: number | null;
  no_account_count: number | null;
  failed_count: number | null;
  decided_by: { first_name: string | null; email: string | null } | null;
}

const FIELDS = [
  '*',
  'user_created.id',
  'user_created.first_name',
  'user_created.email',
  'decided_by.first_name',
  'decided_by.email',
];

/** Every marketing coupon, newest first, optionally only some statuses. */
export function useMarketingCoupons(
  statuses?: readonly MarketingCouponStatus[],
  audience?: 'code' | 'list',
) {
  return useQuery({
    queryKey: ['marketing-coupons', statuses ?? 'all', audience ?? 'any'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'marketing_coupons' as never,
          {
            fields: FIELDS,
            sort: ['-date_created'],
            limit: 200,
            filter: {
              _and: [
                ...(statuses ? [{ status: { _in: statuses } }] : []),
                ...(audience === 'list' ? [{ audience: { _eq: 'list' } }] : []),
                // Rows from before bulk sends have no audience: they are codes.
                ...(audience === 'code'
                  ? [{ _or: [{ audience: { _eq: 'code' } }, { audience: { _null: true } }] }]
                  : []),
              ],
            },
          } as never,
        ),
      )) as unknown as MarketingCoupon[],
  });
}

/** The fields an author sends - never a decision, never what Yiji said. */
export type CouponForm = MarketingCouponDraft & { brand_name?: string | null };

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['marketing-coupons'] });
    void qc.invalidateQueries({ queryKey: ['marketing-activity'] });
  };
}

/** Rows per request when writing a list: quick, and still one modest request. */
const LIST_CHUNK = 500;

/**
 * Save a new draft, or save-and-submit (`submit`).
 *
 * A bulk coupon's list (`recipients`) is written while the coupon is still a
 * draft, and only THEN is the coupon submitted - a manager never sees a
 * coupon whose list is half written. `recipients` undefined = list unchanged.
 */
export function useSaveCoupon() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (v: {
      id?: string;
      form: CouponForm;
      submit: boolean;
      recipients?: string[];
    }) => {
      const base = {
        ...v.form,
        status: 'draft',
        ...(v.recipients ? { recipient_count: v.recipients.length } : {}),
      };
      const row = (await directus.request(
        v.id
          ? updateItem('marketing_coupons' as never, v.id, base as never)
          : createItem('marketing_coupons' as never, base as never),
      )) as unknown as { id: string };
      if (v.recipients) {
        if (v.id) {
          await directus.request(
            deleteItems(
              'marketing_coupon_recipients' as never,
              {
                filter: { coupon: { _eq: row.id } },
              } as never,
            ),
          );
        }
        for (let i = 0; i < v.recipients.length; i += LIST_CHUNK) {
          await directus.request(
            createItems(
              'marketing_coupon_recipients' as never,
              v.recipients
                .slice(i, i + LIST_CHUNK)
                .map((phone) => ({ coupon: row.id, phone, status: 'queued' })) as never,
            ),
          );
        }
      }
      if (v.submit) {
        await directus.request(
          updateItem('marketing_coupons' as never, row.id, {
            status: 'pending',
            submitted_at: new Date().toISOString(),
          } as never),
        );
      }
      await logActivity({
        action: v.submit ? 'submitted' : 'saved_draft',
        subject_type: v.form.audience === 'list' ? 'bulk' : 'coupon',
        subject_id: row.id,
        summary: `${v.submit ? 'Submitted for approval' : 'Saved draft'}: ${v.form.code} - ${v.form.title}${
          v.recipients ? ` (${v.recipients.length} customers)` : ''
        }`,
      });
      return row;
    },
    onSuccess: done,
  });
}

/** Withdraw the author's own draft before anybody decides it. */
export function useCancelCoupon() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (c: MarketingCoupon) => {
      await directus.request(
        updateItem('marketing_coupons' as never, c.id, { status: 'cancelled' } as never),
      );
      await logActivity({
        action: 'cancelled',
        subject_type: 'coupon',
        subject_id: c.id,
        summary: `Cancelled: ${c.code} - ${c.title}`,
      });
    },
    onSuccess: done,
  });
}

/**
 * A manager's decision. Directus refuses it outright for a coupon the manager
 * wrote themselves (four eyes), whatever the page shows.
 */
export function useDecideCoupon() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (v: {
      coupon: MarketingCoupon;
      approve: boolean;
      note: string;
      userId: string;
    }) => {
      await directus.request(
        updateItem('marketing_coupons' as never, v.coupon.id, {
          status: v.approve ? 'approved' : 'rejected',
          decision_note: v.note.trim() || null,
          decided_at: new Date().toISOString(),
          decided_by: v.userId,
        } as never),
      );
      await logActivity({
        action: v.approve ? 'approved' : 'rejected',
        subject_type: 'coupon',
        subject_id: v.coupon.id,
        summary: `${v.approve ? 'Approved' : 'Rejected'}: ${v.coupon.code} - ${v.coupon.title}${
          v.note.trim() ? ` (${v.note.trim()})` : ''
        }`,
      });
    },
    onSuccess: done,
  });
}
