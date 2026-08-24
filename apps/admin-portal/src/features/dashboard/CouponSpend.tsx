import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { couponWorth, type CouponValueFact } from '@yiji/reports';
import { cn, formatDate, HBarChart, ProgressRing, SplitBar, TrendChart } from '@yiji/ui';
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
  /*
   * The ticket-side total and the "with no approval" gap are gone.
   *
   * They existed to reconcile this card against a KPI that summed
   * `tickets.coupon_value` — a figure that counted refused coupons, coupons
   * still awaiting a decision, and amounts nobody ever raised an approval for.
   * That KPI now reads the approval queue's own total, so there are no longer
   * two numbers to reconcile: this card IS the number.
   */
  className?: string;
}

interface CouponRow {
  status: string | null;
  issuing_side: string | null;
  discount_category: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  max_discount: number | string | null;
  date_created: string | null;
}

/** `max_discount` is numeric(10,5) — the driver hands those back as strings. */
function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Exported so the KPI strip can put a coupon count beside the ticket counts
 * without asking the database twice — same query key, so react-query serves
 * both from one fetch.
 */
export function useCouponSpend(from: string, to: string, enabled: boolean) {
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
        createdAt: r.date_created,
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
  const approvedPct = w && w.askedSar > 0 ? (w.sar / w.askedSar) * 100 : 0;

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
        <div className="h-28 animate-pulse rounded-xl bg-secondary/60" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[auto_1fr]">
          {/* ── The headline, with the ring carrying the same fact ──────────
              The ring is the APPROVAL RATE by money: of every riyal that was
              asked for, how much was granted. That is the reading a manager
              actually wants beside a spend figure — a big number alone says
              what was paid, not whether it was paid out freely. */}
          <div className="flex items-center gap-4">
            {/* `label` is the ring's VISIBLE centre text, not just its
                accessible name — so it takes the percentage. The sentence
                explaining what the percentage means goes underneath, where it
                has room; passed into the ring it rendered as a paragraph on
                top of the arc. */}
            <ProgressRing
              value={approvedPct}
              size={72}
              stroke={7}
              tone="primary"
              label={`${Math.round(approvedPct)}%`}
            />
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-extrabold leading-none tracking-[-0.03em] tabular-nums text-primary">
                  {SAR.format(w.sar)}
                </span>
                <span className="text-xs font-semibold text-muted-foreground">
                  {t('couponSpend.sar', { defaultValue: 'SAR' })}
                </span>
              </div>
              <div className="mt-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('couponSpend.issued', { defaultValue: '{{n}} coupons issued', n: w.count })}
              </div>
              <div className="mt-1 text-2xs text-muted-foreground">
                {t('couponSpend.ringLabel', { defaultValue: 'of requested riyals approved' })}
              </div>
            </div>
          </div>

          {/* ── The pipeline, as one bar ────────────────────────────────────
              Approved / pending / refused by MONEY rather than by count, so a
              single large refusal reads as the event it is instead of one
              tick among many. SplitBar draws nothing when every part is zero,
              which is the correct empty state. */}
          <div className="min-w-0 space-y-4">
            <SplitBar
              parts={[
                {
                  label: t('couponSpend.approved', { defaultValue: 'Approved' }),
                  value: w.sar,
                  tone: 'success',
                },
                {
                  label: t('couponSpend.pendingPart', { defaultValue: 'Awaiting' }),
                  value: w.pendingSar,
                  tone: 'warning',
                },
                {
                  label: t('couponSpend.rejectedPart', { defaultValue: 'Refused' }),
                  value: w.rejectedSar,
                  tone: 'destructive',
                },
              ]}
            />

            {/* ── Where it went ──────────────────────────────────────────────
                Bars, not chips. Drawn only when there is more than one issuing
                side: a single full-width bar next to a single total is a
                picture of nothing. It appears by itself when a second side is
                used. */}
            {w.bySide.length > 1 && (
              <div>
                <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('couponSpend.bySide', { defaultValue: 'By issuing side' })}
                </div>
                <HBarChart
                  rows={w.bySide.map((side) => ({
                    label: side.side,
                    values: { sar: side.sar },
                  }))}
                  series={[
                    {
                      key: 'sar',
                      label: t('couponSpend.sar', { defaultValue: 'SAR' }),
                      tone: 'primary',
                    },
                  ]}
                  format={(n) => SAR.format(n)}
                  emptyLabel=""
                />
              </div>
            )}

            {/* ── The shape over time ────────────────────────────────────
                Approved riyals per day. Drawn only with three days or more:
                a two-point line is a slope, not a trend, and reads as more
                certainty than two days of data can carry. */}
            {w.trend.length >= 3 && (
              <div>
                <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('couponSpend.trend', { defaultValue: 'Approved per day' })}
                </div>
                <TrendChart
                  points={w.trend.map((d) => ({
                    label: formatDate(d.day),
                    values: { sar: d.sar },
                  }))}
                  series={[
                    {
                      key: 'sar',
                      label: t('couponSpend.sar', { defaultValue: 'SAR' }),
                      tone: 'primary',
                    },
                  ]}
                  height={110}
                  format={(n) => SAR.format(n)}
                />
              </div>
            )}

            {/* ── How this relates to the KPI above ──────────────────────
                Two money figures on one page look like a contradiction until
                somebody explains them, and nobody was. They answer different
                questions: the KPI sums what every COMPLAINT ended up costing,
                however the coupon was raised; this card sums what went through
                the CRM's own approval queue. The difference is compensation
                that reached a ticket without being approved here. */}

            {/* Said out loud rather than folded into the total — see couponSar. */}
            {w.unpriced > 0 && (
              <p className="text-2xs text-muted-foreground">
                {t('couponSpend.unpriced', {
                  defaultValue: '{{n}} uncapped % coupons not counted',
                  n: w.unpriced,
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
