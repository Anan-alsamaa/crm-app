import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, readItems, updateItem } from '@directus/sdk';
import type { CouponRemoveJob } from '@yiji/shared-types';
import {
  couponIsRemoved,
  isPhoneDerivedCustomerId,
  isYijiRefused,
  ticketCompensationFor,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';
import type { YijiCouponRemover } from '../lib/yiji-coupon-remover.js';
import { couponCustomerPhone, describeRefusal } from './coupon-push.js';

/**
 * TAKE A TICKET'S COUPON BACK (owner, 2026-10-21, EMA-80).
 *
 * A WeCare Admin / Supervisor set the ticket's Compensation to "Not
 * Compensated". The coupon_approvals row is KEPT as the record and marked
 * (`removal_status`, who, when, why); what happens to the coupon depends on
 * where it got to:
 *
 *   never reached the app   (pending, approved-not-delivered, withheld)
 *       -> removed in the CRM only (`not_on_yiji`). A PENDING request is also
 *          closed as rejected so no supervisor approves it afterwards; an
 *          approved one is parked (`yiji_push_error`) so the delivery sweep
 *          never sends it, and the push itself refuses a removed row.
 *   in the customer's app   -> RemoveUserCoupon on the grant, then VERIFIED gone
 *          from GetCouponByUser AND GetActiveCouponByUser (`removed`).
 *   already SPENT on an order -> NOT removed (`used`): it cannot be taken back,
 *          and the ticket stays "Compensated". Never pretended.
 *   Yiji refused / still there -> NOT removed (`failed`, reason recorded).
 *
 * Finally the TICKET is made to match its coupons: "Not Compensated" (coupon
 * columns cleared) only when no coupon still counts, otherwise "Compensated".
 */
export interface CouponRemoveDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  /** Null = removal on Yiji is not configured; a granted coupon then FAILS. */
  remover: YijiCouponRemover | null;
  /** Staging: coupons were granted to this handset, so look IT up. */
  redirectCouponsTo?: string;
  now?: () => Date;
}

export type RemoveOutcome =
  | 'not-found'
  | 'already-removed'
  | 'not-active'
  | 'not-on-yiji'
  | 'removed'
  | 'used'
  | 'failed';

interface RemoveRow {
  id: string;
  status: string | null;
  coupon_code: string | null;
  title: string | null;
  customer_phone: string | null;
  ticket: { id: string } | string | null;
  contact: { phone: string | null; external_customer_id: string | null } | null;
  yiji_coupon_user_id: string | number | null;
  removal_status: string | null;
}

const ticketIdOf = (t: RemoveRow['ticket']): string | null =>
  !t ? null : typeof t === 'string' ? t : (t.id ?? null);

const grantOf = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();

/** Make the ticket's Compensation match the coupons still linked to it. */
export async function syncTicketCompensation(
  directus: YijiDirectusClient,
  ticketId: string,
): Promise<'Compensated' | 'Not Compensated'> {
  const rows = (await directus.request(
    readItems(
      'coupon_approvals' as never,
      {
        filter: { ticket: { _eq: ticketId } },
        fields: ['id', 'status', 'removal_status'],
        limit: -1,
      } as never,
    ),
  )) as unknown as Array<{ status: string | null; removal_status: string | null }>;
  const compensation = ticketCompensationFor(rows ?? []);
  await directus.request(
    updateItem(
      'tickets' as never,
      ticketId,
      (compensation === 'Not Compensated'
        ? { compensation, coupon_code: null, coupon_value: null, coupon_percent: null }
        : { compensation }) as never,
    ),
  );
  return compensation;
}

export async function processCouponRemoveJob(
  job: Job<CouponRemoveJob>,
  deps: CouponRemoveDeps,
): Promise<RemoveOutcome> {
  const { directus, logger, remover, redirectCouponsTo } = deps;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  const { couponApprovalId: id, removedBy, reason } = job.data;
  const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

  const row = (await directus.request(
    readItem('coupon_approvals' as never, id, {
      fields: [
        'id',
        'status',
        'coupon_code',
        'title',
        'customer_phone',
        { ticket: ['id'] },
        { contact: ['phone', 'external_customer_id'] },
        'yiji_coupon_user_id',
        'removal_status',
      ],
    } as never),
  )) as unknown as RemoveRow | null;
  if (!row) {
    logger.warn({ id }, 'coupon removal: no such coupon');
    return 'not-found';
  }
  const ticketId = ticketIdOf(row.ticket);
  const sync = async () => {
    if (!ticketId) return;
    try {
      const value = await syncTicketCompensation(directus, ticketId);
      logger.info(
        { id, ticketId, compensation: value },
        'coupon removal: ticket compensation synced',
      );
    } catch (err) {
      // The coupon's own record is already right; the ticket is re-synced by
      // the next removal or edit. Logged, never thrown (no double removal).
      logger.error({ id, ticketId, err: describeError(err) }, 'could not sync ticket compensation');
    }
  };
  const patch = (data: Record<string, unknown>) =>
    directus.request(updateItem('coupon_approvals' as never, id, data as never));

  if (couponIsRemoved(row)) {
    await sync();
    return 'already-removed';
  }
  if ((row.status ?? '').toLowerCase() === 'rejected' && !grantOf(row.yiji_coupon_user_id)) {
    await sync();
    return 'not-active';
  }

  /* Marked FIRST, so a delivery that starts now sees it and stands down. */
  await patch({
    removal_status: 'pending',
    removed_by: removedBy,
    removed_reason: reason,
    removal_detail: null,
    removed_at: null,
  });

  const fail = async (detail: string): Promise<RemoveOutcome> => {
    await patch({ removal_status: 'failed', removal_detail: detail, removed_at: null });
    logger.warn({ id, code: row.coupon_code, detail }, 'coupon NOT removed');
    await sync();
    return 'failed';
  };

  /* Re-read the receipt AFTER marking: a push that landed in between is now a
     coupon in the customer's app and must be removed from there. */
  const fresh = (await directus.request(
    readItem('coupon_approvals' as never, id, {
      fields: ['status', 'yiji_coupon_user_id'],
    } as never),
  )) as unknown as { status: string | null; yiji_coupon_user_id: string | number | null };
  const grant = grantOf(fresh?.yiji_coupon_user_id ?? row.yiji_coupon_user_id);
  const status = (fresh?.status ?? row.status ?? '').toLowerCase();

  if (!grant) {
    const at = now();
    const extra: Record<string, unknown> = {};
    if (status === 'pending') {
      // Closed, so nobody approves it afterwards. The reason says why.
      extra.status = 'rejected';
      extra.decided_at = at;
      extra.decided_by = removedBy;
      extra.decision_note = `Removed from the ticket: ${reason}`;
    } else if (status === 'approved' || status === 'edited') {
      // Parks it: the delivery sweep skips any row carrying a push error.
      extra.yiji_push_error = 'Removed from the ticket - never sent to the customer.';
    }
    await patch({
      ...extra,
      removal_status: 'not_on_yiji',
      removed_at: at,
      removal_detail: 'It never reached the customer’s Yiji app - removed in the CRM only.',
    });
    logger.info({ id, code: row.coupon_code, status }, 'coupon removed (never reached Yiji)');
    await sync();
    return 'not-on-yiji';
  }

  if (!remover) {
    return fail(
      'Removing a coupon from the Yiji app is not set up on this server, so it is still in the customer’s app.',
    );
  }

  /* Yiji could not be asked: retry; on the last attempt, say so on the row. */
  const unavailable = async (err: unknown): Promise<RemoveOutcome> => {
    if (!lastAttempt) throw err;
    return fail(`Yiji could not be reached (${describeError(err)}). It was NOT removed.`);
  };

  try {
    const phone = redirectCouponsTo?.trim() || couponCustomerPhone(row) || '';
    const ext = row.contact?.external_customer_id?.trim() || '';
    const userId =
      !redirectCouponsTo && ext && !isPhoneDerivedCustomerId(ext)
        ? ext
        : phone
          ? await remover.findCustomer(phone)
          : null;
    if (!userId) {
      return fail(
        'The customer’s Yiji account could not be found to check this coupon. It was NOT removed.',
      );
    }

    /* SPENT already: it cannot be taken back - keep it and say so. */
    const usedOn = await remover.usedOnOrder(userId, grant);
    if (usedOn) {
      await patch({
        removal_status: 'used',
        removed_at: null,
        removal_detail: `Already used by the customer on order ${usedOn} - it cannot be removed.`,
      });
      logger.info({ id, grant, order: usedOn }, 'coupon NOT removed: already used');
      await sync();
      return 'used';
    }

    const before = await remover.wallet(userId);
    const inApp = before.held.includes(grant) || before.active.includes(grant);
    if (inApp) {
      try {
        await remover.removeGrant(grant);
      } catch (err) {
        if (!isYijiRefused(err)) throw err;
        const forbidden = err.status === 401 || err.status === 403;
        return fail(
          `Yiji refused to remove it: ${describeRefusal(err.body)}${
            forbidden ? ' (the CRM’s Yiji account may not remove coupons)' : ''
          }. It is still in the customer’s app.`,
        );
      }
      /* VERIFIED from the customer's own view - it is a soft delete. */
      const after = await remover.wallet(userId);
      if (after.held.includes(grant) || after.active.includes(grant)) {
        return fail('Yiji accepted the removal, but the coupon is still in the customer’s app.');
      }
    }
    await patch({
      removal_status: 'removed',
      removed_at: now(),
      removal_detail: inApp
        ? 'Removed from the customer’s Yiji app - verified gone from their coupon lists.'
        : 'It was no longer in the customer’s Yiji app (expired or already removed).',
    });
    logger.info({ id, grant, userId, inApp }, 'coupon removed from the customer’s Yiji app');
    await sync();
    return 'removed';
  } catch (err) {
    return unavailable(err);
  }
}
