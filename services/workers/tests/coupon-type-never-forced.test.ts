import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  YIJI_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/**
 * THE COUPON TYPE IS THE AGENT'S CHOICE ON EVERY PATH — NEVER FORCED.
 *
 * Owner, 2026-10-07: "this mistake should never happen again. By never I mean
 * never." Until v1.38.8 the order-less path created its coupon with `type`
 * FORCED to General (0), whatever the agent chose, so coupons raised as
 * Private reached Yiji as General — OPS-NRATRG2A among them. Yiji's `type`:
 * 0 = General, 1 = Private; `category`: 1 = Amount, 0 = Percentage (the owner's
 * own console payloads, 2026-10-07).
 *
 * This walks EVERY route the CRM uses to put a coupon on Yiji — by order, by
 * user (create then attach), withheld (created, nobody assigned) — for BOTH
 * types and BOTH categories, and fails if any body that defines a coupon says
 * anything but what the agent chose. A new path, or a "helpful" override in an
 * old one, cannot pass this without being added here and answering to it.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const BASE: CouponApprovalRow = {
  id: 'ca-t',
  status: 'approved',
  coupon_code: 'OPS-TYPECHK1',
  coupon_value: '30.00000',
  coupon_percent: null,
  max_discount: '30.00000',
  usage_limit: '1',
  valid_from: '2026-10-07',
  valid_to: '2026-11-07',
  title: '0502933330',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '293',
  item_name: null,
  no_other_discounts: false,
  reason: 'The customer did not receive the chicken',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0502933330', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
  yiji_push_error: null,
  delivery_excluded: false,
} as unknown as CouponApprovalRow;

const ORDER = {
  userId: 'yiji-user-1',
  customerPhone: '+966502933330',
  restaurantId: 293,
  brandId: 1,
  tenantId: 1,
};

/** Every coupon definition inside a body, whatever envelope the path uses. */
function couponsIn(body: unknown): Array<Record<string, unknown>> {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return [];
  const out: Array<Record<string, unknown>> = [];
  if ('type' in b && 'code' in b) out.push(b); // a CouponVM (AddCoupon)
  const cu = b.couponUser as Record<string, unknown> | undefined;
  if (cu?.coupon) out.push(cu.coupon as Record<string, unknown>); // the order envelope
  if (b.coupon && typeof b.coupon === 'object') out.push(b.coupon as Record<string, unknown>);
  return out;
}

async function bodiesFor(row: CouponApprovalRow) {
  const bodies: Array<{ path: string; body: unknown }> = [];
  const directus = {
    request: vi.fn(async (arg: unknown) =>
      arg && typeof arg === 'object' && 'payload' in (arg as object) ? {} : row,
    ),
  };
  const postCoupon = vi.fn(async (path: string, body: unknown) => {
    bodies.push({ path, body });
    return path === YIJI_UNASSIGNED_COUPON_PATH
      ? { result: 1, exceptionMessage: 'couponId 73900', extendedProperties: {} }
      : { result: 1, exceptionMessage: '0', extendedProperties: { CouponUserId: 21500 } };
  });
  await processCouponPushJob(
    { data: { couponApprovalId: row.id } } as Job<{ couponApprovalId: string }>,
    {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      readOrder: (async () => ORDER) as never,
      findCustomer: (async () => 'yiji-user-1') as never,
      yijiTenantId: '1',
    },
  );
  return bodies;
}

const PATHS: Array<[string, Partial<CouponApprovalRow>, string]> = [
  ['by order', { order_id: '1330455' }, YIJI_COUPON_PATH],
  ['by user, no order (create then attach)', {}, YIJI_UNASSIGNED_COUPON_PATH],
  [
    'withheld (created, assigned to nobody)',
    { delivery_excluded: true },
    YIJI_UNASSIGNED_COUPON_PATH,
  ],
];
const TYPES: Array<[string, number]> = [
  ['Private', 1],
  ['General', 0],
];
const CATEGORIES: Array<[string, number]> = [
  ['Amount', 1],
  ['Percentage', 0],
];

describe('the coupon type and category reach Yiji exactly as the agent chose them', () => {
  for (const [pathName, patch, endpoint] of PATHS) {
    for (const [typeName, typeValue] of TYPES) {
      for (const [catName, catValue] of CATEGORIES) {
        it(`${pathName}: ${typeName} / ${catName} -> type ${typeValue}, category ${catValue}`, async () => {
          const row = {
            ...BASE,
            ...patch,
            coupon_type: typeName,
            discount_category: catName,
            ...(catName === 'Percentage' ? { coupon_value: null, coupon_percent: '10' } : {}),
          } as CouponApprovalRow;
          const bodies = await bodiesFor(row);
          // The path really ran, and really defined a coupon.
          expect(bodies.map((b) => b.path)).toContain(endpoint);
          const coupons = bodies.flatMap((b) => couponsIn(b.body));
          expect(coupons.length).toBeGreaterThan(0);
          for (const c of coupons) {
            expect(c.type).toBe(typeValue);
            expect(c.category).toBe(catValue);
          }
        });
      }
    }
  }
});
