import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { createItem, readItem, readItems, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  approvedCouponPatch,
  couponDecision,
  couponEditBlock,
  couponNumber,
  couponTermsChanges,
  couponTermsOf,
  couponTermsVersion,
  editedCouponTerms,
  replacementTermsProblem,
  YIJI_REACH_LIMIT,
  type CouponEditJob,
  type CouponReplacementTerms,
  type EditableCouponTerm,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';
import {
  YIJI_COUPON_OFF,
  YIJI_COUPON_ON,
  type YijiCouponRemover,
} from '../lib/yiji-coupon-remover.js';
import {
  couponLockKey,
  yijiCouponPayload,
  type CouponApprovalRow,
  type CouponPushLock,
} from './coupon-push.js';
import { resolveCouponCustomer } from './coupon-remove.js';

/**
 * EDIT AN APPROVED COUPON IN PLACE (owner, 2026-11-11; made safe 2026-11-12).
 *
 * The SAME coupon (same Yiji id, same code) takes the new terms on Yiji and on
 * its CRM row - never removed and re-issued (Yiji's monthly report would count
 * two). The owner's conditions (2026-11-12) and how each is met:
 *
 *  - A USED coupon never changes, and the customer cannot use it DURING the
 *    edit: the coupon is SWITCHED OFF on Yiji first (status 5 - it leaves the
 *    wallet and cannot be applied; grants and values stay), and only then is
 *    "was it used?" asked. Asked again just before it is switched back on.
 *  - The record on Yiji MUST really change: after UpdateCoupon the coupon is
 *    READ BACK and every value the edit sets is compared. Only when Yiji shows
 *    exactly the new values does the CRM take them. If Yiji shows anything
 *    else, Yiji is put back as it was and the edit is refused.
 *  - Yiji and the CRM must never disagree: before anything is touched, Yiji's
 *    current values must equal the CRM's. A coupon changed on Yiji outside the
 *    CRM (or switched off / deleted there) is refused, never overwritten.
 *  - One change at a time: one lock per coupon, shared with sending and
 *    removing (`couponLockKey`), and the editor's opened version (`basedOn`)
 *    must still be the coupon's terms - otherwise "changed by someone else".
 *  - Nothing is left half-done: every step can be repeated, so a retry
 *    RESUMES the same edit (`edit_state` = frozen + this request id). An edit
 *    that dies for good is finished by `recoverStuckCouponEdits`, which puts
 *    Yiji back to the CRM's terms and switches the coupon back on.
 *
 * Not on Yiji yet (approved, not sent, or withheld): only the row changes -
 * the push sends the new values. Every outcome lands on the row
 * (`edit_state`, `edit_detail`, `edit_request_id`) for the editor's screen.
 */

export interface CouponEditDeps {
  directus: YijiDirectusClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  remover: YijiCouponRemover | null;
  /** The per-coupon lock (Redis). Absent only in tests. */
  lock?: CouponPushLock;
  redirectCouponsTo?: string;
  now?: () => Date;
}

export type CouponEditOutcome = 'edited' | 'refused';

/** An edit holds its coupon this long at most; every step is short. */
export const COUPON_EDIT_LOCK_MS = 5 * 60_000;
/** The row is mid-edit: the coupon may be switched off on Yiji. */
export const EDIT_FROZEN = 'frozen';
/** `edit_detail` once the CRM row holds the new terms (only switching back on is left). */
const SAVED_PREFIX = 'Saved in the CRM, switching the coupon back on: ';

/**
 * Yiji fields an edit never overwrites: who the coupon is and who holds it.
 * `status` is set explicitly (the coupon stays switched off while it changes).
 */
const YIJI_IDENTITY = new Set(['id', 'code', 'name', 'assignee', 'status', 'tenantId']);

/**
 * What must match on Yiji, both BEFORE an edit (Yiji = the CRM's current
 * terms) and AFTER it (Yiji = the new terms). The money, the limits, the
 * dates, the kind of coupon and the no-other-discounts switches.
 */
export const YIJI_VERIFIED_FIELDS = [
  'discount',
  'discountPercentage',
  'maximumDiscount',
  'reachLimit',
  'limitForUser',
  'monthlyReachLimit',
  'type',
  'category',
  'dontApplyLoyality',
  'dontApplyOffer',
] as const;
const YIJI_VERIFIED_DAYS = ['activationDate', 'expirationDate'] as const;

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
  'edit_state',
  'edit_request_id',
  'edit_detail',
  { contact: ['id', 'name', 'phone', 'external_customer_id'] },
  { ticket: ['id', 'order_id'] },
];

type EditRow = CouponApprovalRow & {
  removal_status?: string | null;
  replaced_by?: unknown;
  compensation?: string | null;
  yiji_used_order?: string | null;
  item_sku?: string | null;
  edit_state?: string | null;
  edit_request_id?: string | null;
  edit_detail?: string | null;
  ticket?: { id?: string; order_id?: string | null } | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const day = (v: unknown) => String(v ?? '').slice(0, 10);
const flag = (v: unknown) => v === true || v === 1 || v === 'true';

/**
 * The Yiji fields of `wanted` that `actual` does not show. Only fields the
 * payload actually sets are compared; numbers as numbers, booleans as
 * booleans, dates by day.
 */
export function yijiMismatch(
  actual: Record<string, unknown> | null,
  wanted: Record<string, unknown>,
): string[] {
  if (!actual) return ['the coupon'];
  const out: string[] = [];
  for (const k of YIJI_VERIFIED_FIELDS) {
    if (!(k in wanted)) continue;
    const w = wanted[k];
    const a = actual[k];
    const same = typeof w === 'boolean' ? flag(a) === w : num(a) === num(w);
    if (!same) out.push(k);
  }
  for (const k of YIJI_VERIFIED_DAYS) {
    if (k in wanted && day(actual[k]) !== day(wanted[k])) out.push(k);
  }
  return out;
}

/** The Yiji coupon a CRM row stands for (the push's own builder). */
function yijiTermsOf(row: EditRow, terms: CouponReplacementTerms, redirect?: string) {
  return yijiCouponPayload({ ...row, ...terms } as unknown as CouponApprovalRow, null, {
    unassigned: true,
    ...(redirect ? { redirectCouponsTo: redirect } : {}),
  }) as unknown as Record<string, unknown>;
}

/** Yiji's own record with `wanted` laid over it - identity and holders untouched. */
function updateBody(current: Record<string, unknown>, wanted: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(wanted)) if (!YIJI_IDENTITY.has(k)) body[k] = v;
  /* Kept SWITCHED OFF: it is switched back on only after the read-back. */
  body.status = YIJI_COUPON_OFF;
  return body;
}

const summaryOf = (
  before: CouponReplacementTerms,
  after: CouponReplacementTerms,
  changes: EditableCouponTerm[],
) =>
  changes
    .map(
      (k) => `${k}: ${String((before as never)[k] ?? '-')} → ${String((after as never)[k] ?? '-')}`,
    )
    .join('; ');

export async function processCouponEditJob(
  job: Job<CouponEditJob>,
  deps: CouponEditDeps,
): Promise<CouponEditOutcome> {
  const id = job.data.couponApprovalId;
  const lastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
  if (!deps.lock) return editOnce(job, deps, lastAttempt);
  const key = couponLockKey(id);
  let mine = false;
  try {
    mine = await deps.lock.acquire(key, COUPON_EDIT_LOCK_MS);
  } catch (err) {
    throw new Error(`coupon lock unavailable: ${describeError(err)}`);
  }
  if (!mine) {
    /* Another change to this coupon (a send, a removal, another edit) is
       running: wait for it (BullMQ retries); on the last try, say so. */
    if (!lastAttempt) throw new Error('another change to this coupon is running');
    /* A row mid-edit (frozen) keeps its mark - it is what the recovery looks
       for; overwriting it would leave the coupon switched off on Yiji for
       good (review 2026-11-12). */
    if (!(await isFrozen(deps, id))) {
      await settle(deps, id, job.data.editRequestId, 'refused', BUSY);
    }
    deps.logger.warn({ id }, 'coupon edit gave up: another change held the coupon');
    return 'refused';
  }
  try {
    return await editOnce(job, deps, lastAttempt);
  } finally {
    await deps.lock.release(key).catch(() => undefined);
  }
}

/** Is an edit of this coupon mid-way (switched off on Yiji)? */
export async function isFrozen(
  deps: Pick<CouponEditDeps, 'directus'>,
  id: string,
): Promise<boolean> {
  const r = (await deps.directus
    .request(readItem('coupon_approvals' as never, id, { fields: ['edit_state'] } as never))
    .catch(() => null)) as { edit_state?: string | null } | null;
  return r?.edit_state === EDIT_FROZEN;
}

const BUSY = 'Not changed: another change to this coupon was still running. Try again in a minute.';

async function settle(
  deps: Pick<CouponEditDeps, 'directus'>,
  id: string,
  editRequestId: string,
  state: 'done' | 'refused' | typeof EDIT_FROZEN,
  detail: string,
  extra: object = {},
) {
  await deps.directus.request(
    updateItem('coupon_approvals' as never, id, {
      ...extra,
      edit_state: state,
      edit_detail: detail.slice(0, 1000),
      edit_request_id: editRequestId,
    } as never),
  );
}

async function editOnce(
  job: Job<CouponEditJob>,
  deps: CouponEditDeps,
  lastAttempt: boolean,
): Promise<CouponEditOutcome> {
  const { directus, logger } = deps;
  const { couponApprovalId: id, editRequestId, editedBy, reason, basedOn } = job.data;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const redirect = deps.redirectCouponsTo;

  const refuse = async (detail: string, extra: object = {}): Promise<CouponEditOutcome> => {
    await settle(deps, id, editRequestId, 'refused', detail, extra);
    logger.warn({ id, editRequestId, detail }, 'coupon edit refused');
    return 'refused';
  };

  const row = (await directus.request(
    readItem('coupon_approvals' as never, id, { fields: ROW_FIELDS } as never),
  )) as unknown as EditRow | null;
  if (!row) return refuse('Not changed: the coupon no longer exists.');

  /* A retry of THIS edit picks up where it stopped (every step repeats safely). */
  const resuming = row.edit_state === EDIT_FROZEN && row.edit_request_id === editRequestId;
  const savedInCrm = resuming && String(row.edit_detail ?? '').startsWith(SAVED_PREFIX);

  if (!resuming) {
    /* 1. What may be edited at all. */
    if (row.edit_state === EDIT_FROZEN) {
      /* NOT written to the row: the frozen mark belongs to the edit still
         finishing (and to the recovery). This editor's screen times out to
         "still working" instead. */
      logger.warn(
        { id, editRequestId, other: row.edit_request_id },
        'coupon edit refused: another edit is finishing',
      );
      return 'refused';
    }
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
    /* 2. Still the coupon the editor opened? (owner: one edit never silently
          overwrites another) */
    if (couponTermsVersion(row as never) !== basedOn) {
      return refuse(
        'Not changed: this coupon was changed by someone else after you opened it. Reload the ticket and edit again.',
      );
    }
  }

  /* Removed, replaced or used WHILE this edit was interrupted (review
     2026-11-12): never write new terms onto it - put Yiji back and stop. */
  const resumeBlock = resuming ? couponEditBlock(row as never) : null;

  /* 3. The new terms pass the same checks as a new request. */
  const before = couponTermsOf(row as never);
  const edited = editedCouponTerms(row as never, job.data.terms as never);
  if (!savedInCrm) {
    const problem = replacementTermsProblem(edited);
    if (problem) return refuse(`Not changed: ${problem}`);
  }
  const changes = couponTermsChanges(row as never, edited as never);
  if (!savedInCrm && changes.length === 0) {
    return refuse('Not changed: the terms are the same as before.');
  }
  /* Issued before the total-limit rule: no limit stored, and Yiji holds the
     old default pool (10000) - not a change made on Yiji (prod, 2026-11-12:
     24 of 69 coupons). Its pool is taken as Yiji has it. */
  const legacyPool = couponNumber(row.total_discount_limit) === null;
  const summary = savedInCrm
    ? String(row.edit_detail).slice(SAVED_PREFIX.length)
    : summaryOf(before, edited, changes);

  /* The CRM row takes the terms (Directus keeps the old values in its revisions). */
  const saveRow = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const k of changes) patch[k] = (edited as never)[k];
    /* A coupon from before the total-limit rule (2026-11-08) has none stored:
       it is recorded now, as the number Yiji is given. */
    if (legacyPool) patch.total_discount_limit = edited.total_discount_limit ?? null;
    return patch;
  };

  const finish = async (onYiji: boolean): Promise<CouponEditOutcome> => {
    const patch = savedInCrm ? {} : saveRow();
    await settle(
      deps,
      id,
      editRequestId,
      'done',
      `Edited${onYiji ? ' on Yiji and' : ''} in the CRM: ${summary}`,
      {
        ...patch,
        ...(savedInCrm ? {} : { replace_reason: reason, edited_at: now(), edited_by: editedBy }),
      },
    );
    await tellTicket(deps, row, edited, summary, reason, editedBy, onYiji, id);
    logger.info(
      { id, code: row.coupon_code, onYiji, summary, by: editedBy },
      'coupon edited in place',
    );
    return 'edited';
  };

  /* 4. Not on Yiji (not sent yet, or withheld): only the row changes. */
  if (!row.yiji_coupon_id) return finish(false);

  const remover = deps.remover;
  if (!remover)
    return refuse('Not changed: editing a coupon on Yiji is not set up on this server.');
  const yijiId = String(row.yiji_coupon_id);
  const wantedOld = yijiTermsOf(row, before, redirect);
  const wantedNew = yijiTermsOf(row, edited, redirect);

  /* Put Yiji back to the CRM's current terms and switch it back on (a refusal path). */
  const putBack = async (current: Record<string, unknown> | null) => {
    if (current && yijiMismatch(current, wantedOld).length) {
      await remover.updateCoupon(updateBody(current, wantedOld));
      const back = await remover.readCoupon(yijiId);
      const still = yijiMismatch(back, wantedOld);
      if (still.length) {
        throw new Error(`Yiji could not be put back (${still.join(', ')})`);
      }
    }
    await remover.setCouponStatus(yijiId, YIJI_COUPON_ON);
  };

  try {
    /* 5. Yiji must show the coupon as the CRM knows it - or, on a resume, as
          the CRM is about to know it. */
    const current = await remover.readCoupon(yijiId);
    const resumeStatus = num(current?.status);
    /* (4) Deleted (1) or expired (6) on Yiji during the edit: never brought
       back to life - left exactly as Yiji has it. */
    if (resuming && (resumeStatus === 1 || resumeStatus === 6)) {
      return refuse(
        resumeStatus === 1
          ? 'Not changed: the coupon was deleted on Yiji during the edit; it was left deleted.'
          : 'Not changed: the coupon expired on Yiji during the edit; it was left as it is.',
      );
    }
    if (resumeBlock && current && current.code === row.coupon_code) {
      if (!savedInCrm) await putBack(current);
      return refuse(
        `Not changed: the coupon was ${resumeBlock === 'used' ? 'used' : 'removed or replaced'} while the edit was interrupted; Yiji was put back as it was.`,
      );
    }
    if (!current || current.code !== row.coupon_code) {
      return refuse(
        `Not changed: Yiji coupon ${yijiId} is not ${row.coupon_code ?? 'this coupon'} (deleted or changed on Yiji).`,
      );
    }
    const status = num(current.status);
    /* A pre-rule coupon's pool: Yiji's own number, read BEFORE anything
       changed; on a resume Yiji may already hold the new pool, so the known
       pre-rule default is used (all 24 such coupons on prod: 10000). */
    if (legacyPool) {
      wantedOld.reachLimit =
        !resuming && 'reachLimit' in current ? current.reachLimit : YIJI_REACH_LIMIT;
    }
    if (!resuming) {
      if (status !== YIJI_COUPON_ON) {
        return refuse(
          status === 1
            ? 'Not changed: this coupon was deleted on Yiji.'
            : status === 6
              ? 'Not changed: this coupon has expired on Yiji. Raise a new coupon instead.'
              : `Not changed: this coupon is switched off on Yiji (status ${status}) - it was changed there, not in the CRM. Check it before editing.`,
        );
      }
      const drift = yijiMismatch(current, wantedOld);
      if (drift.length) {
        return refuse(
          `Not changed: Yiji shows different values from the CRM (${drift.join(', ')}) - the coupon was changed on Yiji outside the CRM. Check it before editing.`,
        );
      }
    } else if (yijiMismatch(current, wantedOld).length && yijiMismatch(current, wantedNew).length) {
      /* Neither the old nor the new terms: put it back and stop. */
      await putBack(current);
      return refuse(
        'Not changed: Yiji showed unexpected values mid-edit; the coupon was put back as it was.',
      );
    }

    /* 6. Switch it OFF before anything else: from here it cannot be used. */
    if (!resuming) {
      await settle(deps, id, editRequestId, EDIT_FROZEN, `Editing: ${summary}`, {
        edited_at: now(),
      });
    }
    if (status !== YIJI_COUPON_OFF) {
      try {
        await remover.setCouponStatus(yijiId, YIJI_COUPON_OFF);
      } catch (err) {
        /* A settled "no" before anything on Yiji changed: stop cleanly. A 401
           or 403 is the owner's admin token (expired or its role changed). */
        if ((err as { name?: string })?.name !== 'YijiRefusedError') throw err;
        const auth = /\((401|403)\)/.test(describeError(err));
        return refuse(
          auth
            ? 'Not changed: Yiji refused the CRM’s admin token (it may have expired). Nothing was changed on Yiji - tell the Administrator.'
            : `Not changed: Yiji would not switch the coupon off for the edit (${describeError(err)}). Nothing was changed.`,
        );
      }
    }
    const off = await remover.readCoupon(yijiId);
    if (num(off?.status) !== YIJI_COUPON_OFF) {
      throw new Error(`Yiji did not switch the coupon off (status ${String(off?.status)})`);
    }

    /* 7. Used? Asked with the coupon switched off, so the answer cannot go stale. */
    const usedCheck = async (): Promise<string | null> => {
      if (!row.yiji_coupon_user_id) return null;
      const userId = await resolveCouponCustomer(remover, row as never, redirect);
      if (!userId) return 'no-customer';
      return remover.usedOnOrder(userId, String(row.yiji_coupon_user_id));
    };
    const usedOn = savedInCrm ? null : await usedCheck();
    if (usedOn === 'no-customer') {
      await putBack(off);
      return refuse(
        'Not changed: the customer’s Yiji account could not be found to check whether the coupon was used.',
      );
    }
    if (usedOn) {
      await putBack(off);
      return refuse(
        `Not changed: the customer already used ${row.coupon_code ?? 'this coupon'} on order ${usedOn} - a used coupon cannot change.`,
        { yiji_used_order: usedOn, yiji_used_at: now() },
      );
    }

    /* 8. The new values, then READ BACK: Yiji must show exactly them. */
    if (yijiMismatch(off, wantedNew).length) {
      try {
        await remover.updateCoupon(updateBody(off!, wantedNew));
      } catch (err) {
        if ((err as { name?: string })?.name !== 'YijiRefusedError') throw err;
        await putBack(await remover.readCoupon(yijiId));
        return refuse(`Not changed: Yiji did not accept the new values (${describeError(err)}).`);
      }
    }
    const after = await remover.readCoupon(yijiId);
    const wrong = yijiMismatch(after, wantedNew);
    if (!after || after.code !== row.coupon_code || wrong.length) {
      await putBack(after);
      return refuse(
        `Not changed: Yiji did not take the new values (${wrong.join(', ') || 'code'}), so the coupon was put back as it was.`,
      );
    }

    /* 9. One more "used?" before it goes back on (an order placed as it was switched off). */
    if (!savedInCrm) {
      const lateUse = await usedCheck();
      if (lateUse && lateUse !== 'no-customer') {
        await putBack(after);
        return refuse(
          `Not changed: the customer used ${row.coupon_code ?? 'this coupon'} on order ${lateUse} while it was being edited; it was put back as it was.`,
          { yiji_used_order: lateUse, yiji_used_at: now() },
        );
      }
    }

    /* 10. The CRM takes the new terms, still marked mid-edit... */
    if (!savedInCrm) {
      await settle(deps, id, editRequestId, EDIT_FROZEN, `${SAVED_PREFIX}${summary}`, {
        ...saveRow(),
        replace_reason: reason,
        edited_at: now(),
        edited_by: editedBy,
      });
    }

    /* 11. ...then it goes back ON with the new values, checked once more. */
    await remover.setCouponStatus(yijiId, YIJI_COUPON_ON);
    const on = await remover.readCoupon(yijiId);
    if (num(on?.status) !== YIJI_COUPON_ON || yijiMismatch(on, wantedNew).length) {
      throw new Error('Yiji did not show the edited coupon switched back on');
    }
  } catch (err) {
    /* An outage or an unexpected answer mid-way: BullMQ retries and the retry
       RESUMES. The last try leaves the row frozen for the recovery sweep. */
    logger.error(
      { id, editRequestId, err: describeError(err), lastAttempt },
      'coupon edit interrupted',
    );
    throw err;
  }

  return finishAfterSave();

  async function finishAfterSave(): Promise<CouponEditOutcome> {
    await settle(deps, id, editRequestId, 'done', `Edited on Yiji and in the CRM: ${summary}`);
    await tellTicket(deps, row!, edited, summary, reason, editedBy, true, id);
    logger.info(
      { id, code: row!.coupon_code, summary, by: editedBy },
      'coupon edited in place on Yiji',
    );
    return 'edited';
  }
}

/** The ticket shows the new value; its history says who changed what and why. */
async function tellTicket(
  deps: CouponEditDeps,
  row: EditRow,
  edited: CouponReplacementTerms,
  summary: string,
  reason: string,
  editedBy: string,
  onYiji: boolean,
  id: string,
) {
  const ticketId = row.ticket?.id ?? null;
  if (!ticketId) return;
  try {
    await deps.directus.request(
      updateItem(
        'tickets' as never,
        ticketId,
        approvedCouponPatch({
          coupon_code: row.coupon_code,
          coupon_value: edited.coupon_value ?? null,
          coupon_percent: edited.coupon_percent ?? null,
          compensation: row.compensation,
        } as never) as never,
      ),
    );
    await deps.directus.request(
      createItem(
        'ticket_events' as never,
        {
          ticket: ticketId,
          event_type: 'commented',
          actor: editedBy,
          payload: {
            text: `Coupon ${row.coupon_code ?? ''} edited (same coupon${onYiji ? ', updated in the customer’s Yiji app' : ''}): ${summary}. Reason: ${reason}`,
            coupon_edited: { code: row.coupon_code, id, summary, reason },
          },
        } as never,
      ),
    );
  } catch (err) {
    deps.logger.error({ ticketId, err: describeError(err) }, 'coupon edit: ticket not updated');
  }
}

/**
 * RECOVERY (every few minutes): an edit whose job died for good leaves its
 * coupon switched off on Yiji. The CRM row is the truth: Yiji is put back to
 * the row's terms (the old ones, or the new ones if the row already took
 * them) and switched back on. Nothing is guessed - every step is read back.
 */
export const COUPON_EDIT_RECOVER_JOB = 'edit-recover';
export const COUPON_EDIT_STUCK_MS = 10 * 60_000;

export async function recoverStuckCouponEdits(
  deps: CouponEditDeps,
): Promise<{ recovered: number; failed: number }> {
  const { directus, logger, remover } = deps;
  const cutoff = new Date(
    (deps.now?.() ?? new Date()).getTime() - COUPON_EDIT_STUCK_MS,
  ).toISOString();
  const rows = (await directus.request(
    readItems(
      'coupon_approvals' as never,
      {
        filter: { edit_state: { _eq: EDIT_FROZEN }, edited_at: { _lt: cutoff } },
        fields: ROW_FIELDS,
        limit: 20,
      } as never,
    ),
  )) as unknown as EditRow[];
  let recovered = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const key = couponLockKey(row.id);
    if (deps.lock && !(await deps.lock.acquire(key, COUPON_EDIT_LOCK_MS).catch(() => false)))
      continue;
    try {
      const saved = String(row.edit_detail ?? '').startsWith(SAVED_PREFIX);
      if (row.yiji_coupon_id && remover) {
        const yijiId = String(row.yiji_coupon_id);
        const wanted = yijiTermsOf(row, couponTermsOf(row as never), deps.redirectCouponsTo);
        const current = await remover.readCoupon(yijiId);
        if (couponNumber(row.total_discount_limit) === null) {
          wanted.reachLimit = YIJI_REACH_LIMIT; // the pre-rule pool (all such coupons: 10000)
        }
        const st = num(current?.status);
        if (current && current.code === row.coupon_code && st !== 1 && st !== 6) {
          if (yijiMismatch(current, wanted).length) {
            await remover.updateCoupon(updateBody(current, wanted));
          }
          await remover.setCouponStatus(yijiId, YIJI_COUPON_ON);
          const back = await remover.readCoupon(yijiId);
          if (num(back?.status) !== YIJI_COUPON_ON || yijiMismatch(back, wanted).length) {
            throw new Error('Yiji did not show the coupon back on with the CRM terms');
          }
        }
      }
      await settle(
        deps,
        row.id,
        row.edit_request_id ?? 'recovery',
        saved ? 'done' : 'refused',
        saved
          ? `Edited on Yiji and in the CRM (finished by the recovery check): ${String(row.edit_detail).slice(SAVED_PREFIX.length)}`
          : 'Not changed: the edit was interrupted; the coupon was put back as it was and switched back on.',
      );
      recovered += 1;
      logger.warn({ id: row.id, saved }, 'stuck coupon edit recovered');
    } catch (err) {
      failed += 1;
      logger.error(
        { id: row.id, err: describeError(err) },
        'stuck coupon edit could not be recovered',
      );
    } finally {
      if (deps.lock) await deps.lock.release(key).catch(() => undefined);
    }
  }
  return { recovered, failed };
}

/** One scheduler on the coupons queue, every 5 minutes, however many worker tasks. */
export async function scheduleCouponEditRecovery(
  queue: Queue,
  everyMs = 5 * 60_000,
): Promise<void> {
  await queue.upsertJobScheduler(
    'coupon-edit-recovery',
    { every: everyMs },
    {
      name: COUPON_EDIT_RECOVER_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
