import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { createItem, readItem, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  approvedCouponPatch,
  couponDecision,
  couponEditBlock,
  replacementTermsProblem,
  type CouponEditJob,
  type CouponReplacementTerms,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';
import type { YijiCouponRemover } from '../lib/yiji-coupon-remover.js';
import { yijiCouponPayload, type CouponApprovalRow } from './coupon-push.js';
import { resolveCouponCustomer } from './coupon-remove.js';

/**
 * EDIT AN APPROVED COUPON IN PLACE (owner, 2026-11-11).
 *
 * The old way removed the coupon from the customer's Yiji app and issued a NEW
 * one (new code): Yiji's monthly "issued coupons" report then counted two
 * coupons for one compensation, against the owner's rule "fix coupons IN
 * PLACE, never re-create" (2026-11-01). Now the SAME coupon changes:
 *
 *   1. the row must be an approval that is not removed, replaced or used;
 *   2. the edited terms pass the same checks as a new request;
 *   3. delivered to a customer: the customer must NOT have used it (a spent
 *      coupon cannot change) - refused, nothing touched;
 *   4. on Yiji: `UpdateCoupon` on the same coupon - Yiji's own record with the
 *      edited values laid over it (same id, code, name and holders) - with the
 *      owner's admin token (the CRM account is 403), then READ BACK to prove it;
 *   5. the same CRM row takes the terms (Directus keeps the old values in its
 *      revisions), the ticket shows the new value and its history says who
 *      changed what and why.
 *
 * Not on Yiji yet (approved, not sent): only the row changes - the push sends
 * the new values. Every outcome lands on the row (`edit_state`, `edit_detail`,
 * `edit_request_id`) for the editor's screen.
 */

export interface CouponEditDeps {
  directus: YijiDirectusClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  remover: YijiCouponRemover | null;
  redirectCouponsTo?: string;
  now?: () => Date;
}

export type CouponEditOutcome = 'edited' | 'refused' | 'failed';

/** The CRM columns an edit may change - never the code, the customer or the ticket. */
const EDITABLE: readonly (
  | keyof CouponReplacementTerms
  | 'coupon_value'
  | 'coupon_percent'
  | 'max_discount'
)[] = [
  'title',
  'issuing_side',
  'delivery_type',
  'coupon_type',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'valid_from',
  'valid_to',
  'usage_limit',
  'total_discount_limit',
  'item_name',
  'item_sku',
  'no_other_discounts',
  'reason',
];

/** Yiji fields that identify the coupon and its holders: never overwritten by an edit. */
const YIJI_IDENTITY = new Set(['id', 'code', 'name', 'assignee', 'status', 'tenantId']);

const ROW_FIELDS = [
  'id',
  'status',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'usage_limit',
  'total_discount_limit',
  'valid_from',
  'valid_to',
  'title',
  'issuing_side',
  'delivery_type',
  'coupon_type',
  'discount_category',
  'brand_id',
  'restaurant_id',
  'item_name',
  'item_sku',
  'no_other_discounts',
  'reason',
  'compensation',
  'customer_phone',
  'removal_status',
  'replaced_by',
  'delivery_excluded',
  'yiji_coupon_id',
  'yiji_coupon_user_id',
  'yiji_used_order',
  { contact: ['id', 'name', 'phone', 'external_customer_id'] },
  { ticket: ['id', 'order_id'] },
];

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const day = (v: unknown) => String(v ?? '').slice(0, 10);

export async function processCouponEditJob(
  job: Job<CouponEditJob>,
  deps: CouponEditDeps,
): Promise<CouponEditOutcome> {
  const { directus, logger } = deps;
  const { couponApprovalId: id, editRequestId, editedBy, reason } = job.data;
  const terms = job.data.terms as unknown as CouponReplacementTerms & Record<string, unknown>;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const lastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);

  const settle = async (state: 'done' | 'refused', detail: string, extra: object = {}) => {
    await directus.request(
      updateItem('coupon_approvals' as never, id, {
        ...extra,
        edit_state: state,
        edit_detail: detail.slice(0, 1000),
        edit_request_id: editRequestId,
      } as never),
    );
  };
  const refuse = async (detail: string, extra: object = {}): Promise<CouponEditOutcome> => {
    await settle('refused', detail, extra);
    logger.warn({ id, editRequestId, detail }, 'coupon edit refused - nothing changed');
    return 'refused';
  };

  const row = (await directus.request(
    readItem('coupon_approvals' as never, id, { fields: ROW_FIELDS } as never),
  )) as unknown as CouponApprovalRow & {
    removal_status?: string | null;
    replaced_by?: unknown;
    compensation?: string | null;
    yiji_used_order?: string | null;
    item_sku?: string | null;
    ticket?: { id?: string; order_id?: string | null } | null;
  };
  if (!row) return refuse('Not changed: the coupon no longer exists.');

  /* 1. What may be edited at all. */
  if (couponDecision(row.status) !== 'approved') {
    return refuse('Not changed: only an approved coupon can be edited.');
  }
  if (row.yiji_used_order) {
    return refuse(
      `Not changed: the customer already used ${row.coupon_code ?? 'this coupon'} on order ${row.yiji_used_order} - a used coupon cannot change.`,
    );
  }
  const block = couponEditBlock(row as never);
  if (block) {
    const why: Record<string, string> = {
      replaced: 'it was already replaced by another coupon',
      removed: 'it was removed from the ticket',
      'removal-pending': 'it is being removed from the ticket',
      used: 'the customer already used it',
      'not-approved': 'it is not approved',
    };
    return refuse(`Not changed: ${why[block] ?? block}.`);
  }

  /* 2. The edited terms pass the same checks as a new request. */
  const edited = { ...row } as Record<string, unknown>;
  for (const k of EDITABLE) if (k in terms) edited[k] = terms[k];
  const problem = replacementTermsProblem(edited as unknown as CouponReplacementTerms);
  if (problem) return refuse(`Not changed: ${problem}`);

  const changes = EDITABLE.filter(
    (k) => JSON.stringify(edited[k] ?? null) !== JSON.stringify((row as never)[k] ?? null),
  );
  if (changes.length === 0) return refuse('Not changed: the terms are the same as before.');

  /* 3 + 4. On Yiji: the same coupon, unused, updated and read back. */
  let onYiji = false;
  if (row.yiji_coupon_id) {
    const remover = deps.remover;
    if (!remover) {
      return refuse('Not changed: editing a coupon on Yiji is not set up on this server.');
    }
    try {
      if (row.yiji_coupon_user_id) {
        const userId = await resolveCouponCustomer(remover, row as never, deps.redirectCouponsTo);
        if (!userId) {
          return refuse(
            'Not changed: the customer’s Yiji account could not be found to check whether the coupon was used.',
          );
        }
        const usedOn = await remover.usedOnOrder(userId, String(row.yiji_coupon_user_id));
        if (usedOn) {
          return refuse(
            `Not changed: the customer already used ${row.coupon_code ?? 'this coupon'} on order ${usedOn} - a used coupon cannot change.`,
            { yiji_used_order: usedOn, yiji_used_at: now() },
          );
        }
      }
      const current = await remover.readCoupon(String(row.yiji_coupon_id));
      if (!current || current.code !== row.coupon_code) {
        return refuse(
          `Not changed: Yiji coupon ${row.yiji_coupon_id} is not ${row.coupon_code ?? 'this coupon'}.`,
        );
      }
      const wanted = yijiCouponPayload(edited as unknown as CouponApprovalRow, null, {
        unassigned: true,
        ...(deps.redirectCouponsTo ? { redirectCouponsTo: deps.redirectCouponsTo } : {}),
      }) as unknown as Record<string, unknown>;
      const body: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(wanted)) if (!YIJI_IDENTITY.has(k)) body[k] = v;
      await remover.updateCoupon(body);

      const after = await remover.readCoupon(String(row.yiji_coupon_id));
      const mismatch = [
        'discount',
        'discountPercentage',
        'maximumDiscount',
        'reachLimit',
        'limitForUser',
      ]
        .filter((k) => k in wanted && num(after?.[k]) !== num(wanted[k]))
        .concat(
          'expirationDate' in wanted && day(after?.expirationDate) !== day(wanted.expirationDate)
            ? ['expirationDate']
            : [],
        );
      if (!after || after.code !== row.coupon_code || mismatch.length) {
        /* Yiji answered OK but does not show the new values: say so, change
           nothing in the CRM, and leave it for a person to look at. */
        return refuse(
          `Not changed in the CRM: Yiji accepted the edit but shows different values (${mismatch.join(', ') || 'code'}). Please check the coupon on Yiji.`,
        );
      }
      onYiji = true;
    } catch (err) {
      const refused = (err as { name?: string })?.name === 'YijiRefusedError';
      if (!refused && !lastAttempt) throw err; // an outage: BullMQ retries
      return refuse(`Not changed: Yiji did not accept the edit (${describeError(err)}).`);
    }
  }

  /* 5. The same CRM row takes the terms; the ticket follows. */
  const patch: Record<string, unknown> = {};
  for (const k of changes) patch[k] = edited[k];
  const summary = changes
    .map((k) => `${k}: ${String((row as never)[k] ?? '-')} → ${String(edited[k] ?? '-')}`)
    .join('; ');
  await settle('done', `Edited${onYiji ? ' on Yiji and' : ''} in the CRM: ${summary}`, {
    ...patch,
    replace_reason: reason,
    edited_at: now(),
    edited_by: editedBy,
  });

  const ticketId = row.ticket?.id ?? null;
  if (ticketId) {
    try {
      await directus.request(
        updateItem(
          'tickets' as never,
          ticketId,
          approvedCouponPatch({
            coupon_code: row.coupon_code,
            coupon_value: num(edited.coupon_value),
            coupon_percent: num(edited.coupon_percent),
            compensation: row.compensation,
          } as never) as never,
        ),
      );
      await directus.request(
        createItem(
          'ticket_events' as never,
          {
            ticket: ticketId,
            event_type: 'commented',
            actor: editedBy,
            payload: {
              text: `Coupon ${row.coupon_code ?? ''} edited (same coupon${onYiji ? ', updated in the customer’s Yiji app' : ''}): ${summary}. Reason: ${reason}`,
              coupon_edited: { code: row.coupon_code, id, changes: patch, reason },
            },
          } as never,
        ),
      );
    } catch (err) {
      logger.error({ ticketId, err: describeError(err) }, 'coupon edit: ticket not updated');
    }
  }
  logger.info(
    { id, code: row.coupon_code, onYiji, changes, by: editedBy },
    'approved coupon edited in place',
  );
  return 'edited';
}
