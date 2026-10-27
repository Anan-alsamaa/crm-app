import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  RULE_COUPON_LIMIT_SETTING_KEY,
  parseRuleCouponLimit,
  ruleCouponCountFilter,
  ruleLimitReached,
  ruleLimitSince,
  type CompensationRule,
  type RuleCouponLimit,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * The compensation rules, read for the Add-ticket form's PRE-FILL (owner,
 * 2026-10-27). Best-effort by design: an environment without the collection
 * yet, or a role without the read, gets NO rules - the form then works exactly
 * as it did before, with nothing pre-filled. Never a Yiji call.
 */
const RULE_FIELDS = [
  'id',
  'name',
  'active',
  'priority',
  'complaint_type',
  'service_type',
  'min_delay_minutes',
  'min_order_value',
  'max_order_value',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'validity_days',
  'usage_limit',
  'delivery_type',
  'coupon_type',
  'issuing_side',
  'no_other_discounts',
  'date_created',
];

const NUMERIC = [
  'priority',
  'min_delay_minutes',
  'min_order_value',
  'max_order_value',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'validity_days',
  'usage_limit',
] as const;

function toRule(r: Record<string, unknown>): CompensationRule {
  const out: Record<string, unknown> = { ...r, id: String(r.id), active: r.active !== false };
  for (const k of NUMERIC) {
    const v = r[k];
    out[k] = v === null || v === undefined || v === '' ? null : Number(v);
  }
  out.priority = (out.priority as number | null) ?? 0;
  return out as unknown as CompensationRule;
}

export function useCompensationRules(enabled = true) {
  return useQuery({
    queryKey: ['compensation-rules', 'active'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<CompensationRule[]> => {
      try {
        const rows = (await directus.request(
          readItems(
            'compensation_rules' as never,
            {
              filter: { active: { _eq: true } },
              fields: RULE_FIELDS,
              limit: -1,
            } as never,
          ),
        )) as unknown as Array<Record<string, unknown>>;
        return rows.map(toRule);
      } catch {
        return [];
      }
    },
  });
}

/**
 * Whether THIS customer already reached the optional per-customer limit on
 * rule coupons. False when the limit is off, unreadable, or there is no
 * customer yet. One bounded read (at most N rows), only when the limit is on.
 */
export function useRuleLimitReached(contactId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['compensation-rules', 'limit-reached', contactId],
    enabled: enabled && !!contactId,
    staleTime: 60_000,
    queryFn: async (): Promise<{ reached: boolean; limit: RuleCouponLimit | null }> => {
      try {
        const settings = (await directus.request(
          readItems(
            'app_settings' as never,
            {
              filter: { key: { _eq: RULE_COUPON_LIMIT_SETTING_KEY } },
              fields: ['value'],
              limit: 1,
            } as never,
          ),
        )) as unknown as Array<{ value: unknown }>;
        const limit = parseRuleCouponLimit(settings[0]?.value ?? null);
        if (!limit || !contactId) return { reached: false, limit };
        const rows = (await directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              filter: ruleCouponCountFilter(contactId, ruleLimitSince(limit, new Date())),
              fields: ['id'],
              limit: limit.maxPerCustomer,
            } as never,
          ),
        )) as unknown as unknown[];
        return { reached: ruleLimitReached(rows.length, limit), limit };
      } catch {
        return { reached: false, limit: null };
      }
    },
  });
}
