import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill } from '@yiji/ui';
import { snapshotLines, snapshotLinesTotal, type LateOrderSnapshot } from './api.js';

/**
 * THE ORDER AS IT STOOD when the agent decided (owner spec §19, 2026-09-30).
 *
 * Renders `late_order_decisions.order_snapshot` — a frozen copy written at
 * decision time. **It makes no network calls.** That is the whole point of §19:
 * the report can hold thousands of rows, and asking Yiji for each one's detail
 * would be thousands of calls for a panel nobody has opened. The snapshot was
 * already being captured on every decision; nothing read it back until now.
 *
 * Deliberately NOT the agent portal's `OrderDetails`. That component takes a
 * live `YijiOrder` plus a `vendorId` and offers things that make no sense in a
 * report — raise a ticket from this order, open the courier's tracking. A
 * snapshot is a frozen subset with no vendor, and importing across portals would
 * drag the agent portal's commerce client in with it.
 */
export function OrderSnapshotPanel({
  snapshot,
}: {
  snapshot: LateOrderSnapshot | null | undefined;
}): JSX.Element {
  const { t } = useTranslation();

  /*
   * NOTHING CAPTURED IS A FACT, NOT A BLANK PANEL.
   *
   * Two ways a row arrives here with no snapshot, and both are normal: a PENDING
   * order has no decision, so nothing was ever captured; and a handful of
   * decisions predate the column. An empty panel would read as "this order had
   * nothing in it", which is the failure shape this codebase keeps producing —
   * see [[silent-empty-failures]]. So it says which it is.
   */
  if (!snapshot) {
    return (
      <p className="px-5 py-4 text-xs text-muted-foreground">
        {t('lateOrdersReport.snapshot.none', {
          defaultValue:
            'No order detail was captured for this row - it is either still pending, or it was decided before the order was recorded.',
        })}
      </p>
    );
  }

  const lines = snapshotLines(snapshot);
  const linesTotal = snapshotLinesTotal(lines);
  const currency = snapshot.currency?.trim() || 'SAR';
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
    } catch {
      return `${n} ${currency}`;
    }
  };

  /* The order's OWN stored total, when it has one. Shown BESIDE the sum of the
     lines rather than instead of it: a difference is a real fact about the order
     — a delivery fee, a discount, a coupon already applied — and showing only one
     of the two numbers would make that look like an arithmetic error. */
  const storedTotal = typeof snapshot.total === 'number' ? snapshot.total : null;

  const facts: Array<[string, string | null]> = [
    [
      t('lateOrdersReport.snapshot.orderStatus', { defaultValue: 'Order status' }),
      snapshot.status
        ? t(`commerce.orderStatuses.${snapshot.status}`, { defaultValue: snapshot.status })
        : null,
    ],
    [
      t('lateOrdersReport.snapshot.payment', { defaultValue: 'Payment' }),
      [snapshot.paymentStatus, snapshot.paymentMode].filter(Boolean).join(' - ') || null,
    ],
    [
      t('lateOrdersReport.snapshot.deliveryType', { defaultValue: 'Delivery' }),
      snapshot.deliveryType ?? null,
    ],
    [
      t('lateOrdersReport.snapshot.branch', { defaultValue: 'Brand / branch' }),
      [snapshot.brandName, snapshot.restaurantName].filter(Boolean).join(' - ') || null,
    ],
  ];

  return (
    <div className="space-y-4 px-5 py-4">
      <div>
        <h4 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('lateOrdersReport.snapshot.items', { defaultValue: 'Items' })}
        </h4>
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('lateOrdersReport.snapshot.noItems', { defaultValue: 'No items were recorded.' })}
          </p>
        ) : (
          <ul className="space-y-2">
            {lines.map((l, i) => (
              <li
                key={`${l.sku ?? l.name}-${i}`}
                className="grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-3 text-sm"
              >
                {/* Quantity in its own column so the eye runs straight down it,
                    rather than starting at a different x on every line. */}
                <span className="justify-self-start rounded-md bg-secondary px-1.5 py-0.5 text-center text-2xs font-semibold tabular-nums text-muted-foreground">
                  {l.qty}&times;
                </span>
                <span className="min-w-0 font-medium text-foreground">
                  {l.name}
                  {l.category && (
                    <span className="ms-1.5 text-2xs text-muted-foreground">{l.category}</span>
                  )}
                </span>
                {/*
                  THE LINE, NOT THE UNIT PRICE.

                  `price` in a snapshot is Yiji's `itemPrice` — the price of ONE —
                  and rendering it raw is the money bug the owner caught on the
                  coupon form: three waters at 1 SAR reading "1". The unit is
                  named in brackets so the multiplication is visible rather than
                  asserted.
                */}
                <span className="shrink-0 tabular-nums font-medium text-foreground">
                  {l.qty > 1 && (
                    <span className="me-1.5 text-2xs font-normal text-muted-foreground">
                      ({fmt(l.unit)} {t('commerce.each', { defaultValue: 'each' })})
                    </span>
                  )}
                  {fmt(l.lineTotal)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The money, on a tinted strip rather than under a rule — a hairline
          across a panel is the boxed look this design system avoids. */}
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 rounded-2xl bg-secondary/50 px-4 py-3 text-xs text-muted-foreground">
        <span>
          {t('lateOrdersReport.snapshot.linesTotal', { defaultValue: 'Items total' })}:{' '}
          <span className="tabular-nums text-foreground">{fmt(linesTotal)}</span>
        </span>
        {storedTotal !== null && (
          <span>
            {t('lateOrdersReport.snapshot.orderTotal', { defaultValue: 'Order total' })}:{' '}
            <span className="tabular-nums text-foreground">{fmt(storedTotal)}</span>
          </span>
        )}
      </div>

      {/* Each fact is one short pair, and a fact with no value is left OUT rather
          than rendered as a dash beside a label. */}
      <dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
        {facts
          .filter((f): f is [string, string] => !!f[1])
          .map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {label}
              </dt>
              <dd dir="auto" className="min-w-0 truncate font-medium text-foreground">
                {value}
              </dd>
            </div>
          ))}
      </dl>

      {snapshot.deliveryAddress && (
        <p dir="auto" className="text-xs leading-relaxed text-muted-foreground">
          {snapshot.deliveryAddress}
        </p>
      )}

      {/* WHEN the copy was taken — what makes this a snapshot rather than a claim
          about the order now. The row's own columns may disagree with it, and
          that difference is history rather than an error. */}
      {snapshot.capturedAt && (
        <Pill tone="neutral" size="sm">
          {t('lateOrdersReport.snapshot.capturedAt', {
            when: new Date(snapshot.capturedAt).toLocaleString(),
            defaultValue: 'Captured {{when}}',
          })}
        </Pill>
      )}
    </div>
  );
}
