import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { couponWorth, type CouponValueFact } from '@yiji/reports';
import { cn } from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { canSeeCouponMoney, useAuth } from '../../lib/auth/AuthContext.js';

/**
 * What compensation is COSTING — total riyals on issued coupons, split by who
 * issued them.
 *
 * Lives on the dashboard rather than in a section of its own: it answers the
 * same question as everything else on this page ("what is the operation doing
 * right now"), and a page nobody visits is a metric nobody reads.
 *
 * TWO GATES, and only one of them is security:
 *
 *   1. `canSeeCouponMoney` decides whether to render. This is a PRODUCT
 *      decision — payout totals are commercial, and not everyone who can open
 *      the admin portal needs the number.
 *   2. Directus decides what the session may actually read from
 *      `coupon_approvals`. That is the real boundary, enforced server-side; a
 *      role without read permission gets nothing back no matter what the UI
 *      does. The query is not even issued when gate 1 says no, so a role that
 *      should not see this never asks for it.
 *
 * The range follows the dashboard's own filter so the figure always matches
 * the complaints beside it. Coupons are dated by `date_created` — when the
 * coupon was raised — which is what ties it to the complaint that caused it.
 */

interface Props {
  /** ISO `yyyy-mm-dd`, from the dashboard's applied filter. Empty = no bound. */
  from: string;
  to: string;
  className?: string;
}

interface CouponRow {
  status: string | null;
  issuing_side: string | null;
  discount_category: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  max_discount: number | string | null;
}

/** `max_discount` is numeric(10,5) — the driver hands those back as strings. */
function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function useCouponSpend(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: ['coupon-spend', from, to],
    enabled,
    queryFn: async (): Promise<CouponValueFact[]> => {
      const filter: Record<string, unknown> = {};
      if (from) filter['date_created'] = { _gte: `${from}T00:00:00` };
      if (to) {
        filter['date_created'] = {
          ...(filter['date_created'] as object | undefined),
          // Inclusive of the whole end day — a coupon raised at 16:40 on the
          // last day of the range belongs to the range.
          _lte: `${to}T23:59:59`,
        };
      }
      const rows = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: [
              'status',
              'issuing_side',
              'discount_category',
              'coupon_value',
              'coupon_percent',
              'max_discount',
            ],
            ...(Object.keys(filter).length ? { filter } : {}),
            limit: -1,
          } as never,
        ),
      )) as unknown as CouponRow[];

      return rows.map((r) => ({
        status: r.status,
        issuingSide: r.issuing_side,
        discountCategory: r.discount_category,
        couponValue: num(r.coupon_value),
        couponPercent: num(r.coupon_percent),
        maxDiscount: num(r.max_discount),
      }));
    },
  });
}

const SAR = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function CouponSpend({ from, to, className }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const { user } = useAuth();
  const allowed = canSeeCouponMoney(user);
  const q = useCouponSpend(from, to, allowed);

  // Render nothing at all rather than an empty shell: a card that says
  // "restricted" advertises the number's existence to somebody who cannot have
  // it, and a card that says "0 SAR" to a role whose permissions returned
  // nothing would be a lie.
  if (!allowed || q.isError) return null;

  const w = q.data ? couponWorth(q.data) : null;

  return (
    <div
      className={cn(
        'rounded-2xl bg-card px-5 py-4 shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in',
        className,
      )}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t('couponSpend.title', { defaultValue: 'Coupons approved here' })}
        </h3>
        <span className="text-2xs text-muted-foreground">
          {t('couponSpend.rangeNote', {
            defaultValue: 'Raised and approved in this CRM, in the selected range',
          })}
        </span>
      </div>

      {!w ? (
        <div className="h-16 animate-pulse rounded-xl bg-secondary/60" />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          {/* The headline: what was actually paid out. */}
          <div className="flex items-baseline gap-2.5">
            <span className="text-3xl font-extrabold leading-none tracking-[-0.03em] tabular-nums text-primary">
              {SAR.format(w.sar)}
            </span>
            <span className="text-xs font-semibold text-muted-foreground">
              {t('couponSpend.sar', { defaultValue: 'SAR' })}
            </span>
            {/* The count rides the same baseline rather than sitting under the
                number. Stacked, a lone caption under a lone figure left the
                card looking half-filled. */}
            <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('couponSpend.issued', { defaultValue: '{{n}} coupons issued', n: w.count })}
            </span>
          </div>

          {/*
            By issuing side — but ONLY when there is more than one.
            With a single side the chip restates the headline exactly ("254"
            beside "254 SAR"), which reads as a mistake rather than a
            breakdown. The split appears by itself the moment a second issuing
            side is used, which is the point at which it starts saying
            something.
          */}
          {w.bySide.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {w.bySide.map((s) => (
                <span
                  key={s.side}
                  className="inline-flex items-baseline gap-2 rounded-xl bg-primary-tint/60 px-3 py-2 ring-1 ring-primary/15"
                >
                  <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-primary">
                    {s.side}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-foreground">
                    {SAR.format(s.sar)}
                  </span>
                  <span className="text-2xs text-muted-foreground tabular-nums">×{s.count}</span>
                </span>
              ))}
            </div>
          )}

          {/* Said out loud rather than folded into the total — see couponSar. */}
          {w.unpriced > 0 && (
            <div className="text-2xs text-warning-foreground">
              {t('couponSpend.unpriced', {
                defaultValue: '{{n}} uncapped % coupons not counted',
                n: w.unpriced,
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
