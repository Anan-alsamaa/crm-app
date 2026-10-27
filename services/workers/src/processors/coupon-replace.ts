import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { createItem, readItem, updateItem } from '@directus/sdk';
import {
  approvedCouponPatch,
  couponDecision,
  couponEditBlock,
  couponIsRemoved,
  couponReplacedHistoryText,
  couponTermsProblems,
  refId,
  type CouponRemoveJob,
  type CouponReplaceJob,
  type RelationRef,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';
import type { YijiCouponRemover } from '../lib/yiji-coupon-remover.js';
import {
  processCouponRemoveJob,
  resolveCouponCustomer,
  type RemoveOutcome,
} from './coupon-remove.js';

/**
 * EDIT AN APPROVED COUPON = REPLACE IT (owner, 2026-10-27).
 *
 * The editor's portal has already created the REPLACEMENT row (approved, the
 * edited terms, a fresh code, `replaces` -> the old row). Its delivery is held
 * by the push (`replacementBlocksPush`) until this job has:
 *
 *   1. checked the pair is what it claims (the new row replaces THIS coupon and
 *      was created by the person the gateway verified);
 *   2. checked the old coupon can be edited at all - still an approval, not
 *      removed, not already replaced - and, when it reached the customer's
 *      app, that they have NOT USED it (GetOrderByUser; a spent coupon cannot
 *      be pulled back, so the edit is refused and nothing changes);
 *   3. CLAIMED the old row (`replaced_by` -> new): from here it is history;
 *   4. taken the old coupon off the customer's Yiji app with the EMA-80
 *      removal, in-process, so its outcome decides what happens next;
 *   5. released the new one: ticket gets its code/value, the history line is
 *      written, and the delivery is queued (the sweep is the safety net).
 *
 * Any refusal before the old coupon is gone ROLLS BACK: the new row becomes
 * `rejected` with the reason (it never counts, never delivers) and the claim is
 * cleared - the customer keeps exactly the coupon they had.
 *
 * Retry-safe: every step re-reads its state. A transient Yiji failure throws
 * (BullMQ retries) until the last attempt, which rolls back instead. A run that
 * finds its own claim already in place resumes at the removal.
 */
export interface CouponReplaceDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  /** Null = Yiji removal not configured; a coupon already in the app is then refused. */
  remover: YijiCouponRemover | null;
  /** Staging: coupons were granted to this handset. */
  redirectCouponsTo?: string;
  /** Queue the replacement's delivery. Best-effort - the sweep is the net. */
  enqueuePush?: (couponApprovalId: string) => Promise<unknown>;
  now?: () => Date;
}

export type ReplaceOutcome =
  /** The old coupon is gone and the new one released for delivery. */
  | 'replaced'
  /** The customer already spent the old coupon - nothing changed. */
  | 'used'
  /** Yiji refused / could not be reached / not set up - nothing changed. */
  | 'failed'
  /** Not editable (rejected, removed, already replaced, bad pair) - nothing changed. */
  | 'refused'
  | 'not-found';

interface OldRow {
  id: string;
  status: string | null;
  coupon_code: string | null;
  title: string | null;
  customer_phone: string | null;
  ticket: { id: string } | string | null;
  contact: { phone: string | null; external_customer_id: string | null } | null;
  yiji_coupon_user_id: string | number | null;
  removal_status: string | null;
  removal_detail?: string | null;
  replaced_by: RelationRef;
}

interface NewRow {
  id: string;
  status: string | null;
  coupon_code: string | null;
  coupon_value: number | string | null;
  coupon_percent: number | string | null;
  max_discount: number | string | null;
  discount_category: string | null;
  compensation: string | null;
  replaces: RelationRef;
  decided_by: RelationRef;
  user_created?: RelationRef;
}

const OLD_FIELDS = [
  'id',
  'status',
  'coupon_code',
  'title',
  'customer_phone',
  { ticket: ['id'] },
  { contact: ['phone', 'external_customer_id'] },
  'yiji_coupon_user_id',
  'removal_status',
  'removal_detail',
  'replaced_by',
];

const NEW_FIELDS = [
  'id',
  'status',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'discount_category',
  'compensation',
  'replaces',
  'decided_by',
  'user_created',
];

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const grantOf = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();

/** Why an edit is refused, in words the editor reads on the card. */
const BLOCKED: Record<string, string> = {
  'not-approved': 'This coupon is not an approved one any more, so it cannot be edited.',
  replaced: 'This coupon was already replaced by another edit - edit the new one instead.',
  removed: 'This coupon was removed from its ticket, so it cannot be edited.',
  'removal-pending': 'This coupon is being removed from its ticket - try again in a minute.',
  used: 'The customer already used this coupon on an order - a used coupon cannot be taken back, so it was not changed.',
};

export async function processCouponReplaceJob(
  job: Job<CouponReplaceJob>,
  deps: CouponReplaceDeps,
): Promise<ReplaceOutcome> {
  const { directus, logger, remover, redirectCouponsTo } = deps;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  const { couponApprovalId: oldId, replacementId: newId, editedBy, reason } = job.data;
  const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

  const read = async <T>(id: string, fields: unknown[]): Promise<T | null> => {
    try {
      return (await directus.request(
        readItem('coupon_approvals' as never, id, { fields } as never),
      )) as unknown as T | null;
    } catch (err) {
      /* A missing item answers FORBIDDEN in Directus: treat as not there. Any
         other failure is an outage - retry rather than act on a guess. */
      if (/FORBIDDEN|not found/i.test(describeError(err))) return null;
      throw err;
    }
  };
  const patch = (id: string, data: Record<string, unknown>) =>
    directus.request(updateItem('coupon_approvals' as never, id, data as never));

  const [old, fresh] = await Promise.all([
    read<OldRow>(oldId, OLD_FIELDS),
    read<NewRow>(newId, NEW_FIELDS),
  ]);
  if (!old || !fresh) {
    logger.warn({ oldId, newId }, 'coupon edit: a row is missing - nothing done');
    return 'not-found';
  }
  /* Not a pair: never touch a row that is not this coupon's replacement. */
  if (refId(fresh.replaces) !== oldId) {
    logger.warn({ oldId, newId, replaces: refId(fresh.replaces) }, 'coupon edit: not a pair');
    return 'refused';
  }

  const claim = refId(old.replaced_by);
  /** The new row never takes effect; the old one stays exactly as it was. */
  const rollback = async (
    note: string,
    outcome: ReplaceOutcome,
    extra: Record<string, unknown> = {},
  ): Promise<ReplaceOutcome> => {
    // Rejected FIRST, so it can never be delivered whatever fails next.
    await patch(newId, { status: 'rejected', decision_note: note, decided_at: now(), ...extra });
    if (refId(old.replaced_by) === newId || claim === newId) {
      await patch(oldId, { replaced_by: null, replace_reason: null });
    }
    logger.info({ oldId, newId, outcome, note }, 'coupon edit rolled back - nothing changed');
    return outcome;
  };

  /* Already rolled back: just make sure the claim is gone too (a retry of a
     rollback that failed half-way). */
  if (couponDecision(fresh.status) === 'rejected') {
    if (claim === newId) await patch(oldId, { replaced_by: null, replace_reason: null });
    return 'refused';
  }
  if (claim && claim !== newId) {
    return rollback(BLOCKED.replaced!, 'refused');
  }

  /* The replacement must be the verified editor's own row. */
  const creator = refId(fresh.user_created) ?? refId(fresh.decided_by);
  if (creator !== editedBy) {
    return rollback(
      'Refused: this replacement was not created by the person who asked for the edit.',
      'refused',
    );
  }
  if (couponDecision(fresh.status) !== 'approved') {
    return rollback('Refused: the replacement is not an approved coupon.', 'refused');
  }
  const termsWrong = couponTermsProblems({
    discount_category: fresh.discount_category,
    coupon_value: num(fresh.coupon_value),
    coupon_percent: num(fresh.coupon_percent),
    max_discount: num(fresh.max_discount),
  })[0];
  if (termsWrong) return rollback(`Refused: ${termsWrong.message}`, 'refused');

  const resumed = claim === newId;
  /* A previous run finished everything but the follow-ups. */
  const alreadyDone = resumed && couponIsRemoved(old);

  if (!resumed) {
    const block = couponEditBlock(old);
    if (block) return rollback(BLOCKED[block]!, block === 'used' ? 'used' : 'refused');

    /* WAS IT USED? Only a coupon that reached the customer's app can have
       been; asked for this ONE coupon, server-side, behind the Yiji guard. */
    const grant = grantOf(old.yiji_coupon_user_id);
    if (grant) {
      if (!remover) {
        return rollback(
          'Not changed: taking a coupon out of the Yiji app is not set up on this server.',
          'failed',
        );
      }
      try {
        const userId = await resolveCouponCustomer(remover, old, redirectCouponsTo);
        if (!userId) {
          return rollback(
            'Not changed: the customer’s Yiji account could not be found to check whether the coupon was used.',
            'failed',
          );
        }
        const usedOn = await remover.usedOnOrder(userId, grant);
        if (usedOn) {
          return rollback(
            `Not changed: the customer already used ${old.coupon_code ?? 'this coupon'} on order ${usedOn} - a used coupon cannot be taken back.`,
            'used',
          );
        }
      } catch (err) {
        if (!lastAttempt) throw err;
        return rollback(
          `Not changed: Yiji could not be reached to check the coupon (${describeError(err)}).`,
          'failed',
        );
      }
    }

    /* CLAIM: from here the old row is history (and out of every total). */
    await patch(oldId, { replaced_by: newId, replace_reason: reason });
    old.replaced_by = newId;
  }

  /* TAKE THE OLD ONE BACK - the EMA-80 removal, in-process (admin token for
     RemoveUserCoupon, verified gone from the customer's lists). */
  /* A transient Yiji failure throws (not the last attempt): the claim stays
     and the retry resumes right here. */
  const removal: RemoveOutcome = await processCouponRemoveJob(
    {
      data: {
        couponApprovalId: oldId,
        removedBy: editedBy,
        reason: `Replaced by ${fresh.coupon_code ?? 'a new coupon'} (edited): ${reason}`,
      },
      attemptsMade: job.attemptsMade,
      opts: job.opts,
    } as unknown as Job<CouponRemoveJob>,
    {
      directus,
      logger,
      remover,
      ...(redirectCouponsTo ? { redirectCouponsTo } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );

  if (
    removal === 'used' ||
    removal === 'failed' ||
    removal === 'not-found' ||
    removal === 'not-active'
  ) {
    const after = await read<OldRow>(oldId, ['removal_detail']);
    const detail = after?.removal_detail?.trim();
    return rollback(
      removal === 'used'
        ? `Not changed: ${detail || 'the customer already used this coupon on an order.'}`
        : `Not changed: the old coupon could not be taken out of the customer’s Yiji app${detail ? ` - ${detail}` : '.'}`,
      removal === 'used' ? 'used' : 'failed',
    );
  }

  /* RELEASED. The ticket shows the new coupon, the history says why, and the
     delivery goes (the push now finds the old row claimed AND removed). */
  const ticketId = !old.ticket ? null : typeof old.ticket === 'string' ? old.ticket : old.ticket.id;
  if (ticketId) {
    try {
      await directus.request(
        updateItem(
          'tickets' as never,
          ticketId,
          approvedCouponPatch({
            coupon_code: fresh.coupon_code,
            coupon_value: num(fresh.coupon_value),
            coupon_percent: num(fresh.coupon_percent),
            compensation: fresh.compensation,
          }) as never,
        ),
      );
    } catch (err) {
      logger.error({ ticketId, err: describeError(err) }, 'coupon edit: ticket not updated');
    }
    if (!alreadyDone) {
      try {
        let editor: string | null = null;
        try {
          const u = (await directus.request(
            readItem('directus_users' as never, editedBy, {
              fields: ['first_name', 'last_name', 'email'],
            } as never),
          )) as unknown as {
            first_name?: string | null;
            last_name?: string | null;
            email?: string | null;
          } | null;
          editor =
            [u?.first_name, u?.last_name].filter((x) => x?.trim()).join(' ') || u?.email || null;
        } catch {
          /* the line still says what happened */
        }
        await directus.request(
          createItem(
            'ticket_events' as never,
            {
              ticket: ticketId,
              event_type: 'commented',
              actor: editedBy,
              payload: {
                text: couponReplacedHistoryText({
                  oldCode: old.coupon_code,
                  newCode: fresh.coupon_code,
                  editor,
                  reason,
                }),
                coupon_replaced: {
                  from: old.coupon_code,
                  to: fresh.coupon_code,
                  old_id: oldId,
                  new_id: newId,
                  reason,
                },
              },
            } as never,
          ),
        );
      } catch (err) {
        logger.error(
          { ticketId, err: describeError(err) },
          'coupon edit: history line not written',
        );
      }
    }
  }
  if (deps.enqueuePush) {
    try {
      await deps.enqueuePush(newId);
    } catch (err) {
      logger.warn(
        { newId, err: describeError(err) },
        'coupon edit: push not queued - the sweep will',
      );
    }
  }
  logger.info(
    { oldId, newId, from: old.coupon_code, to: fresh.coupon_code, removal, by: editedBy },
    'approved coupon replaced',
  );
  return 'replaced';
}
