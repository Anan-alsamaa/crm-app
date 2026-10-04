import { useTranslation } from 'react-i18next';
import { cn, LongText, Pill } from '@yiji/ui';
import { causeLabel } from '@yiji/shared-types';
import { useLateOrderDecisionForOrder } from './api.js';

/**
 * WHY THIS ORDER WAS LATE, AND WHAT WAS ALREADY DONE — on the ticket.
 *
 * Reported by operations (EMA-26 §4, 2026-10-04): *"The selected Reason and
 * Action Taken are currently not displayed in the User CRM. Both fields should
 * be visible in the customer/order details for proper tracking and
 * follow-up."*
 *
 * Both have always been recorded, and both were visible only in the late-orders
 * QUEUE — the screen an agent leaves the moment they raise a ticket from it. So
 * the agent who picks that ticket up next sees an order, a customer and a
 * complaint, and nothing about the lateness that caused all three. They then
 * either ask the customer a question the company has already answered, or do
 * again what a colleague did an hour ago.
 *
 * RENDERS NOTHING when there is no decision, which is the common case: most
 * tickets have nothing to do with a late order. An empty card on every ticket
 * would be worse than no card, and it must not be confused with a decision
 * whose fields are blank — the hook returns null for "could not read" too, and
 * both resolve to the same honest silence.
 */
export function LateOrderDecisionCard({
  orderId,
  className,
}: {
  /** The ticket's order number. Nothing renders without one. */
  orderId: string | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const decision = useLateOrderDecisionForOrder(orderId);
  const d = decision.data;

  /* Nothing recorded against this order — which is most tickets. Silent. */
  if (!d) return null;
  /* A decision row with neither field filled says nothing worth a card. It can
     exist: a coupon decision is written before the wording in some paths. */
  const reason = d.reason?.trim();
  const action = d.action_taken?.trim();
  if (!reason && !action) return null;

  /* `first_name` only — that is all the agent portal's decision query asks
     for, and it is what the queue shows beside a decision. */
  const decidedBy = d.decided_by?.first_name?.trim() ?? '';

  return (
    <section
      className={cn(
        'rounded-xl border border-border/80 bg-secondary/30 p-3.5',
        'text-xs leading-relaxed',
        className,
      )}
    >
      <header className="mb-2.5 flex flex-wrap items-center gap-2">
        <h4 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('lateOrders.decisionHeading', { defaultValue: 'Late order' })}
        </h4>
        {/* THE CAUSE, spelled out. `lateOrders.kind.*` translates the seeded
            two; anything operations added falls back to `causeLabel`, which
            turns `late_preparation` into "Late preparation" rather than
            printing the raw enum with its underscore. */}
        {d.kind && (
          <Pill tone="neutral" size="sm">
            {t(`lateOrders.kind.${d.kind}`, { defaultValue: causeLabel(d.kind) })}
          </Pill>
        )}
        {/* WHO decided, because the next agent's first question is who to ask. */}
        {decidedBy && <span className="text-2xs text-muted-foreground">{decidedBy}</span>}
      </header>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {reason && (
          <div className="min-w-0">
            <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('lateOrders.reasonLabel', { defaultValue: 'Reason' })}
            </dt>
            {/* `LongText` rather than a raw string: these are free text an agent
                typed, and a long one would otherwise push the ticket's own
                content off screen. The whole value is on hover and on focus,
                and can be selected and copied. */}
            <dd className="mt-0.5 min-w-0 text-foreground">
              <LongText value={reason} />
            </dd>
          </div>
        )}
        {action && (
          <div className="min-w-0">
            <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('lateOrders.actionLabel', { defaultValue: 'Action taken' })}
            </dt>
            <dd className="mt-0.5 min-w-0 text-foreground">
              <LongText value={action} />
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
