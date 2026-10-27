import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import {
  RULE_COUPON_LIMIT_SETTING_KEY,
  parseRuleCouponLimit,
  type CompensationRule,
  type RuleCouponLimit,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * THE COMPENSATION RULES (owner, 2026-10-27) - read and written by the admin
 * portal's "Compensation rules" page (`manage_compensation_rules`).
 *
 * A rule only SUGGESTS a coupon: the agent portal pre-fills a new ticket's
 * coupon section with it, and a Yiji ticket sent without a coupon gets it as a
 * PENDING request. A supervisor approves every one.
 */

/** The columns the page reads and writes - exactly the collection's own. */
export const RULE_COLUMNS = [
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
  'note',
  'date_created',
] as const;

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

/** Directus hands decimals back as strings; the page and the matcher want numbers. */
export function normaliseRule(r: Record<string, unknown>): CompensationRule {
  const out: Record<string, unknown> = { ...r, id: String(r.id), active: r.active !== false };
  for (const k of NUMERIC) {
    const v = r[k];
    out[k] = v === null || v === undefined || v === '' ? null : Number(v);
  }
  out.priority = (out.priority as number | null) ?? 0;
  return out as unknown as CompensationRule;
}

export const RULES_QUERY_KEY = ['compensation-rules'] as const;

export function useCompensationRules() {
  return useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'compensation_rules' as never,
          {
            fields: [...RULE_COLUMNS],
            sort: ['complaint_type', '-priority', 'name'],
            limit: -1,
          } as never,
        ),
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(normaliseRule);
    },
  });
}

/** What the editor saves: every column but the id and the timestamp. */
export type RuleValues = Omit<CompensationRule, 'id' | 'date_created'>;

export function useSaveCompensationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string | null; values: RuleValues }) =>
      id
        ? directus.request(updateItem('compensation_rules' as never, id, values as never))
        : directus.request(createItem('compensation_rules' as never, values as never)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
  });
}

/** Turn one rule on or off without opening it. */
export function useToggleCompensationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      directus.request(updateItem('compensation_rules' as never, id, { active } as never)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
  });
}

/**
 * Delete a rule. Coupons it produced keep their record: `policy_rule` is SET
 * NULL on delete, so history is never taken with it.
 */
export function useDeleteCompensationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      directus.request(deleteItem('compensation_rules' as never, id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
  });
}

/* ── The optional per-customer limit (one app_settings row; default off) ── */

export interface RuleLimitSetting {
  /** The app_settings row, when one exists. */
  rowId: string | null;
  enabled: boolean;
  maxPerCustomer: number | null;
  windowDays: number | null;
  /** The limit as the matcher applies it; null = off. */
  effective: RuleCouponLimit | null;
}

const LIMIT_KEY = ['compensation-rules', 'customer-limit'] as const;

export function readLimitSetting(
  row: { id: string; value: unknown } | undefined,
): RuleLimitSetting {
  let raw: Record<string, unknown> = {};
  try {
    raw =
      typeof row?.value === 'string'
        ? (JSON.parse(row.value) as Record<string, unknown>)
        : ((row?.value as Record<string, unknown>) ?? {});
  } catch {
    raw = {};
  }
  const n = (v: unknown) =>
    Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
  return {
    rowId: row?.id ?? null,
    enabled: raw.enabled === true,
    maxPerCustomer: n(raw.maxPerCustomer),
    windowDays: n(raw.windowDays),
    effective: parseRuleCouponLimit(row?.value ?? null),
  };
}

export function useRuleLimitSetting() {
  return useQuery({
    queryKey: LIMIT_KEY,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'app_settings' as never,
          {
            filter: { key: { _eq: RULE_COUPON_LIMIT_SETTING_KEY } },
            fields: ['id', 'value'],
            limit: 1,
          } as never,
        ),
      )) as unknown as Array<{ id: string; value: unknown }>;
      return readLimitSetting(rows[0]);
    },
  });
}

export function useSaveRuleLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      rowId,
      enabled,
      maxPerCustomer,
      windowDays,
    }: {
      rowId: string | null;
      enabled: boolean;
      maxPerCustomer: number | null;
      windowDays: number | null;
    }) => {
      const value = JSON.stringify({ enabled, maxPerCustomer, windowDays });
      return rowId
        ? directus.request(updateItem('app_settings' as never, rowId, { value } as never))
        : directus.request(
            createItem(
              'app_settings' as never,
              { key: RULE_COUPON_LIMIT_SETTING_KEY, value } as never,
            ),
          );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIMIT_KEY }),
  });
}
