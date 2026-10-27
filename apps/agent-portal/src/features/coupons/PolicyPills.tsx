import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill } from '@yiji/ui';

/**
 * WHERE A COUPON CAME FROM, POLICY-WISE (owner, 2026-10-27).
 *
 * "From rule <name>" when a compensation rule suggested or raised it, and a
 * "Differs from policy" pill when the agent changed the terms that rule
 * suggested - the supervisor must see that before approving. Nothing when the
 * coupon has no rule behind it (or the columns are not applied yet).
 */
export function PolicyPills({
  rule,
  differs,
}: {
  rule: { id: string; name: string | null } | string | null | undefined;
  differs: boolean | null | undefined;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (!rule) return null;
  const name = typeof rule === 'object' ? rule.name?.trim() : '';
  return (
    <>
      <Pill tone="muted" size="sm" data-testid="policy-rule-pill">
        {name
          ? t('coupons.fromRule', { defaultValue: 'Rule: {{name}}', name })
          : t('coupons.fromRuleUnnamed', { defaultValue: 'From a compensation rule' })}
      </Pill>
      {differs === true && (
        <Pill tone="warning" size="sm" dot data-testid="differs-from-policy-pill">
          {t('coupons.differsPill', { defaultValue: 'Differs from policy' })}
        </Pill>
      )}
    </>
  );
}
