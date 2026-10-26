import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '@yiji/ui';
import type { CouponFailureKind } from './coupon-request-send.js';

/**
 * "THE COUPON WAS NOT SENT" — and the agent has to answer it (owner, 2026-10-25).
 *
 * A toast was all the agent got before, and a toast is gone in five seconds:
 * the ticket was saved, the coupon was not, and nobody was holding the promise
 * made to the customer. This stays until it is answered — Esc and the backdrop
 * do nothing — with exactly two ways out:
 *
 *  - Retry sends the SAME request again (same id, so never twice);
 *  - Don't add a coupon leaves the ticket Not Compensated, as it already is.
 *
 * Its own file so it carries over to a release branch without the redesign.
 */
export interface CouponNotSentDialogProps {
  open: boolean;
  kind: CouponFailureKind;
  /** The server's own words, short and sanitised, when it had any. */
  detail?: string | null;
  status?: number | null;
  retrying: boolean;
  onRetry: () => void;
  onSkip: () => void;
}

const noop = () => undefined;

export function CouponNotSentDialog({
  open,
  kind,
  detail,
  status,
  retrying,
  onRetry,
  onSkip,
}: CouponNotSentDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const reason = t(`coupons.notSent.reason.${kind}`, { defaultValue: REASON_EN[kind] });
  return (
    <Modal open={open} onClose={noop} hideChrome size="sm">
      <div role="alertdialog" aria-labelledby="coupon-not-sent-title" className="p-7">
        <h2
          id="coupon-not-sent-title"
          className="font-display text-xl font-bold tracking-tight text-foreground"
        >
          {t('coupons.notSent.title', { defaultValue: 'The coupon was not sent' })}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('coupons.notSent.body', {
            defaultValue:
              'The ticket is saved as Not Compensated. The coupon request did not reach the server.',
          })}
        </p>
        <div className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-foreground">
          <p className="font-medium">
            {reason}
            {status ? <span className="text-muted-foreground"> (HTTP {status})</span> : null}
          </p>
          {detail && (
            <p dir="auto" className="mt-1 break-words text-xs text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onSkip} disabled={retrying}>
            {t('coupons.notSent.skip', { defaultValue: "Don't add a coupon" })}
          </Button>
          <Button type="button" onClick={onRetry} loading={retrying}>
            {t('coupons.notSent.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const REASON_EN: Record<CouponFailureKind, string> = {
  network: 'No connection to the server.',
  server: 'The server did not answer. It may be restarting.',
  session: 'Your session had expired.',
  permission: 'Your account is not allowed to request coupons.',
  invalid: 'The server refused the coupon details.',
  duplicate_code: 'That coupon code is already used.',
  prepare: 'The coupon details could not be prepared.',
  unknown: 'Something unexpected went wrong.',
};
