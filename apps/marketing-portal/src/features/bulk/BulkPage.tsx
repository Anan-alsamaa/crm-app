import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MARKETING_COUPON_EDITABLE, staffDisplayName } from '@yiji/shared-types';
import { Button, EmptyState, MeterBar, Spinner, cn, toast } from '@yiji/ui';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useCancelCoupon, useMarketingCoupons, type MarketingCoupon } from '../coupons/api.js';
import { CouponFormDrawer } from '../coupons/CouponFormDrawer.js';
import { StatusBadge, discountText } from '../coupons/CouponsPage.js';

/**
 * BULK SENDS (owner, 2026-11-02): one coupon put in the wallet of every
 * customer on a list. Each is a marketing coupon whose audience is a list, so
 * it goes through the same approval as any other, and the worker hands it out
 * at a steady pace once it is approved.
 */
export function BulkPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const q = useMarketingCoupons(undefined, 'list');
  const cancel = useCancelCoupon();
  const [editing, setEditing] = useState<MarketingCoupon | null>(null);
  const [open, setOpen] = useState(false);
  const rows = q.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('bulk.title', { defaultValue: 'Bulk coupons' })}
        description={t('bulk.desc', {
          defaultValue:
            'One coupon for a whole list of customers. Upload the numbers, submit, and after a manager approves it each customer receives it in the app.',
        })}
        actions={
          <Button
            variant="brand"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            {t('bulk.new', { defaultValue: 'New bulk send' })}
          </Button>
        }
      />
      <div className={PAGE_BODY}>
        {q.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('bulk.empty', { defaultValue: 'No bulk sends yet' })}
            description={t('bulk.emptyHint', {
              defaultValue: 'Press "New bulk send" and upload a list of customers.',
            })}
          />
        ) : (
          <div className="space-y-3">
            {rows.map((c) => {
              const total = c.recipient_count ?? 0;
              const sent = c.sent_count ?? 0;
              const none = c.no_account_count ?? 0;
              const failed = c.failed_count ?? 0;
              const done = sent + none + failed;
              const editable =
                c.user_created?.id === user?.id && MARKETING_COUPON_EDITABLE.includes(c.status);
              return (
                <div key={c.id} className={cn(SECTION_CARD, 'p-5')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-sm font-semibold">{c.code}</span>
                    <span className="text-md font-semibold">{c.title}</span>
                    <StatusBadge status={c.status} />
                    <span className="ms-auto text-xs text-muted-foreground">
                      {discountText(c)} · {String(c.valid_from).slice(0, 10)} →{' '}
                      {String(c.valid_to).slice(0, 10)} · {staffDisplayName(c.user_created, '—')}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm tabular-nums">
                    <span>
                      {t('bulk.customers', { defaultValue: 'Customers' })}:{' '}
                      <b>{total.toLocaleString()}</b>
                    </span>
                    {(c.status === 'sending' || c.status === 'created') && (
                      <>
                        <span className="text-success">
                          {t('bulk.sent', { defaultValue: 'Received it' })}: {sent.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">
                          {t('bulk.noAccount', { defaultValue: 'No Yiji account' })}:{' '}
                          {none.toLocaleString()}
                        </span>
                        <span className={failed ? 'text-destructive' : 'text-muted-foreground'}>
                          {t('bulk.failed', { defaultValue: 'Failed' })}: {failed.toLocaleString()}
                        </span>
                      </>
                    )}
                  </div>
                  {c.status === 'sending' && total > 0 && (
                    <MeterBar className="mt-3" value={Math.round((done / total) * 100)} />
                  )}
                  {c.status === 'rejected' && c.decision_note && (
                    <p className="mt-2 text-xs text-destructive">{c.decision_note}</p>
                  )}
                  {c.status === 'failed' && c.send_error && (
                    <p className="mt-2 text-xs text-destructive">{c.send_error}</p>
                  )}
                  {editable && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing(c);
                          setOpen(true);
                        }}
                      >
                        {t('actions.edit', { defaultValue: 'Edit' })}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancel.isPending}
                        onClick={() =>
                          cancel.mutate(c, {
                            onError: () =>
                              toast.error(
                                t('coupons.cancelFailed', { defaultValue: 'Could not cancel it' }),
                              ),
                          })
                        }
                      >
                        {t('bulk.cancel', { defaultValue: 'Cancel bulk send' })}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <CouponFormDrawer
        open={open}
        coupon={editing}
        audience="list"
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
