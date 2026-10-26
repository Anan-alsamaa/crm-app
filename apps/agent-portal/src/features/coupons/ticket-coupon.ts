import { compensationFlag } from '@yiji/shared-types';
import type { CreateCouponRequestInput } from './api.js';
import {
  COUPON_LOG_TAG,
  CouponRequestError,
  classifyCouponError,
  retryTransient,
  type SendOptions,
} from './coupon-request-send.js';

/**
 * RAISE THE COUPON FOR A TICKET JUST SAVED, AND ONLY THEN CALL IT COMPENSATED
 * (owner, 2026-10-21: "only when a coupon is issued/assigned the compensated
 * should be there"; 2026-10-25: keep it Not Compensated until the coupon row
 * actually exists).
 *
 * The ticket used to be created Compensated and flipped back when the coupon
 * failed — so for a second it claimed a coupon nobody had, and when the flip
 * itself failed it kept claiming it. Now the ticket is created Not Compensated
 * and this marks it Compensated after the request row is written, the same
 * order the ticket card's "Assign a coupon" already follows (EMA-80).
 *
 * Plain functions in, so the Add-ticket form (standalone or from a chat) and
 * any later caller share one sequence, and it can be tested without React.
 */
export type TicketCouponOutcome = { ok: true } | { ok: false; error: CouponRequestError };

export async function raiseTicketCoupon({
  ticketId,
  input,
  send,
  markCompensated,
  retry,
}: {
  ticketId: string;
  /** Carries its own `id`: a Retry passes the same input, so the same id. */
  input: CreateCouponRequestInput & { id: string };
  /** `useRequestCouponApproval().mutateAsync` — idempotent and retried. */
  send: (input: CreateCouponRequestInput) => Promise<unknown>;
  /** Writes `compensation` on the ticket. */
  markCompensated: (ticketId: string, value: 'Compensated') => Promise<unknown>;
  retry?: Pick<SendOptions, 'delays' | 'sleep'>;
}): Promise<TicketCouponOutcome> {
  try {
    await send(input);
  } catch (err) {
    if (err instanceof CouponRequestError) return { ok: false, error: err };
    const c = classifyCouponError(err);
    return {
      ok: false,
      error: new CouponRequestError({
        kind: c.kind === 'duplicate_id' ? 'invalid' : c.kind,
        status: c.status,
        detail: c.detail,
        attempts: 1,
        requestId: input.id,
      }),
    };
  }
  /* The coupon exists; the ticket may say so now. A failure here is logged,
     not shown: the request is real and waiting on a supervisor, and the
     approval writes the ticket's coupon fields when it is decided. */
  await retryTransient(
    () => markCompensated(ticketId, compensationFlag(true) as 'Compensated'),
    retry,
  ).catch((err) =>
    console.error(
      `${COUPON_LOG_TAG} the coupon was sent, but the ticket could not be marked Compensated`,
      { ticketId, requestId: input.id, error: err },
    ),
  );
  return { ok: true };
}
