import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WHO MAY EDIT A COUPON (owner, 2026-11-14):
 *  - PENDING: the agent who raised it may correct it (My coupons), the coupon
 *    terms only - never the status, the decision, the customer or the order;
 *  - once approved/assigned: only "Edit coupon" (edit_approved_coupons -
 *    WeCare Supervisor, WeCare Admin, Administrator).
 * The agent portal's correction sends the WHOLE coupon, and coupon-terms-guard
 * judges the coupon as it will be stored, so one changed value never drops
 * the others.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SYNC = read('../../../directus/extensions/app-roles-sync/index.js');
const MY = read('../../../apps/agent-portal/src/features/coupons/MyCouponsPage.tsx');
const API = read('../../../apps/agent-portal/src/features/coupons/api.ts');

const listOf = (src: string, start: string, end: string) =>
  src.slice(src.indexOf(start) + start.length, src.indexOf(end, src.indexOf(start)));

describe('an agent edits only their own PENDING coupon request', () => {
  const block = listOf(SYNC, '    request_coupons: [', '    ],');
  const fields = listOf(SYNC, 'const PENDING_COUPON_EDIT_FIELDS = [', '];')
    .split(/[\s,]+/)
    .map((f) => f.replace(/'/g, ''))
    .filter(Boolean);

  it('the update grant is scoped to pending + requested by the current user', () => {
    expect(block).toMatch(/g\(\s*'coupon_approvals',\s*'update',/);
    expect(block).toMatch(/status: \{ _eq: 'pending' \}/);
    expect(block).toMatch(/requested_by: \{ _eq: '\$CURRENT_USER' \}/);
    expect(block).toMatch(/PENDING_COUPON_EDIT_FIELDS/);
  });

  it('the agent can change the terms but never the status, decision, customer or order', () => {
    for (const f of [
      'coupon_type',
      'discount_category',
      'valid_from',
      'valid_to',
      'usage_limit',
      'total_discount_limit',
    ]) {
      expect(fields).toContain(f);
    }
    for (const f of [
      'status',
      'decided_by',
      'decided_at',
      'contact',
      'ticket',
      'order_id',
      'requested_by',
      'yiji_coupon_id',
    ]) {
      expect(fields).not.toContain(f);
    }
  });

  it('the portal edit is pending-only and its patch matches the grant', () => {
    expect(API).toMatch(/status: \{ _eq: 'pending' \}/);
    const patchType = listOf(API, 'export interface PendingCouponPatch {', '\n}');
    const sent = [...patchType.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]);
    expect(sent.sort()).toEqual([...fields].sort());
  });

  it('a correction sends every term, not only the changed one', () => {
    const save = listOf(MY, 'await updateRequest.mutateAsync({', '});');
    for (const f of [
      'coupon_type',
      'discount_category',
      'valid_from',
      'valid_to',
      'coupon_value',
      'coupon_percent',
      'max_discount',
      'usage_limit',
      'total_discount_limit',
    ]) {
      expect(save).toContain(`${f}:`);
    }
  });
});
