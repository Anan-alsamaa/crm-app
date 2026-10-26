import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  isUnknownVendor,
  isYijiUnavailable,
  vendorIdOf,
  type VendorConnector,
  type VendorRef,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';
import { couponCustomerPhone } from './coupon-push.js';
import type { CouponConnectors } from './coupon-vendor.js';

/**
 * "DOES THIS CUSTOMER HAVE A YIJI ACCOUNT?" - ASKED ONCE, STORED (owner, after
 * the 2026-10-26 prod incident).
 *
 * The admin Coupon approvals card asked Yiji live (`/commerce/customer-exists`)
 * for every card, re-asked on refocus, and flooded Yiji until it throttled us
 * and the late-orders TV went stale. The page must NEVER call Yiji. Instead
 * this job, every couple of minutes, takes at most `batch` PENDING requests
 * that have a deliverable phone, are not withheld (`delivery_excluded`) and
 * were never checked (or last checked over a day ago), looks each phone up
 * ONCE through the row's vendor connector - the same `findCustomerIdByPhone`
 * the coupon push and the signup watch use - and writes the answer to
 * `yiji_customer_found` / `yiji_customer_checked_at`. The card only reads it.
 *
 * Bounded by construction: one scheduler for every worker task, attempts 1,
 * <= `batch` lookups a run (default 10 per 2 min = 5/min), every one behind
 * the outbound Yiji guard (a workers `customer.lookup` is `normal`). A refusal
 * or an outage is NOT an answer: the row stays unchecked and the run STOPS -
 * the next run tries again. Missing fields (no manual `apply:fields` yet) make
 * the read fail before any Yiji call, so the job is inert until they exist.
 */

export const COUPON_CUSTOMER_CHECK_JOB = 'coupon_customer_check';
const SCHEDULER = 'coupon-customer-check';
export const DEFAULT_COUPON_CUSTOMER_CHECK_MS = 2 * 60_000;
/** Most Yiji lookups one run makes. */
export const COUPON_CUSTOMER_CHECK_BATCH = 10;
/** A still-pending request is looked up again after this long. */
export const COUPON_CUSTOMER_RECHECK_MS = 24 * 60 * 60_000;
/** Rows read per run to find `batch` with a phone - a Directus read, not Yiji. */
const CANDIDATE_READ_LIMIT = 100;

interface CandidateRow {
  id: string;
  customer_phone?: string | null;
  title?: string | null;
  contact?: { phone?: string | null } | null;
  vendor?: VendorRef;
  yiji_customer_checked_at?: string | null;
}

export interface CouponCustomerCheckDeps {
  directus: YijiDirectusClient;
  connectors: CouponConnectors;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  batch?: number;
}

export interface CouponCustomerCheckResult {
  /** Yiji lookups made this run (answered or not). */
  looked: number;
  found: number;
  notFound: number;
  /** Why the run ended before its batch, if it did. */
  stopped?: 'read-failed' | 'yiji-unavailable' | 'write-failed';
}

const FIELDS = [
  'id',
  'customer_phone',
  'title',
  'vendor',
  'yiji_customer_checked_at',
  { contact: ['phone'] },
];

/** Pending, not withheld, and unchecked / stale. Newest first: the queue is worked from the top. */
async function readCandidates(directus: YijiDirectusClient, now: Date): Promise<CandidateRow[]> {
  const staleBefore = new Date(now.getTime() - COUPON_CUSTOMER_RECHECK_MS).toISOString();
  const base = [
    { status: { _eq: 'pending' } },
    { _or: [{ delivery_excluded: { _null: true } }, { delivery_excluded: { _eq: false } }] },
  ];
  const read = (extra: object, sort: string[]) =>
    directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          fields: FIELDS,
          filter: { _and: [...base, extra] },
          sort,
          limit: CANDIDATE_READ_LIMIT,
        } as never,
      ) as never,
    ) as unknown as Promise<CandidateRow[]>;
  /* Never-checked first; then the stalest re-checks. */
  const fresh = await read({ yiji_customer_checked_at: { _null: true } }, ['-date_created']);
  const stale = await read({ yiji_customer_checked_at: { _lt: staleBefore } }, [
    'yiji_customer_checked_at',
  ]);
  return [...(fresh ?? []), ...(stale ?? [])];
}

export async function runCouponCustomerCheck(
  deps: CouponCustomerCheckDeps,
): Promise<CouponCustomerCheckResult> {
  const { directus, connectors, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const batch = Math.max(0, deps.batch ?? COUPON_CUSTOMER_CHECK_BATCH);
  const result: CouponCustomerCheckResult = { looked: 0, found: 0, notFound: 0 };

  let rows: CandidateRow[];
  try {
    rows = await readCandidates(directus, now);
  } catch (err) {
    logger.warn(
      { err: describeError(err) },
      'coupon customer check: could not read pending coupons - are coupon_approvals.yiji_customer_found / yiji_customer_checked_at applied?',
    );
    return { ...result, stopped: 'read-failed' };
  }

  /* Each vendor's connector once per run; null = that vendor cannot be served. */
  const byVendor = new Map<string, VendorConnector | null>();
  let legacyVendor: string | null | undefined;
  const connectorFor = async (ref: VendorRef): Promise<VendorConnector | null> => {
    let key = vendorIdOf(ref);
    if (!key) {
      if (legacyVendor === undefined) {
        try {
          legacyVendor = await connectors.defaultVendorForLegacyRecords();
        } catch (err) {
          if (!isUnknownVendor(err)) throw err;
          legacyVendor = null;
        }
      }
      key = legacyVendor;
    }
    if (!key) return null;
    if (!byVendor.has(key)) {
      try {
        byVendor.set(key, await connectors.connectorFor(key));
      } catch (err) {
        if (!isUnknownVendor(err)) throw err;
        logger.warn({ vendor: key, reason: err.reason }, 'coupon customer check: unknown vendor');
        byVendor.set(key, null);
      }
    }
    return byVendor.get(key) ?? null;
  };

  const seen = new Set<string>();
  for (const row of rows) {
    if (result.looked >= batch) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    /* The phone the card shows and the push delivers to - same picker. */
    const phone = couponCustomerPhone(row);
    if (!phone) continue;

    let connector: VendorConnector | null;
    try {
      connector = await connectorFor(row.vendor ?? null);
    } catch (err) {
      logger.warn({ id: row.id, err: describeError(err) }, 'coupon customer check: no connector');
      continue;
    }
    /* No connector, or no phone lookup configured: nothing was asked, so
       nothing is recorded - "not checked" is the honest state. */
    const find = connector?.findCustomerIdByPhone;
    if (!find) continue;

    let customerId: string | null;
    result.looked += 1;
    try {
      customerId = await find(phone);
    } catch (err) {
      if (isYijiUnavailable(err)) {
        /* Guard refusal (budget / breaker) or Yiji down: not an answer. Stop -
           pressing on would only add to whatever Yiji is going through. */
        logger.warn(
          { id: row.id, err: describeError(err) },
          'coupon customer check: Yiji unavailable - left unchecked, next run retries',
        );
        return { ...result, stopped: 'yiji-unavailable' };
      }
      logger.warn(
        { id: row.id, err: describeError(err) },
        'coupon customer check: lookup failed - left unchecked',
      );
      continue;
    }

    const found = Boolean(customerId);
    try {
      await directus.request(
        updateItem('coupon_approvals' as never, row.id, {
          yiji_customer_found: found,
          yiji_customer_checked_at: now.toISOString(),
        } as never) as never,
      );
    } catch (err) {
      logger.warn(
        { id: row.id, err: describeError(err) },
        'coupon customer check: could not store the answer - stopping this run',
      );
      return { ...result, stopped: 'write-failed' };
    }
    if (found) result.found += 1;
    else result.notFound += 1;
  }

  if (result.looked > 0) logger.info({ ...result }, 'coupon customer check ran');
  return result;
}

/** One job scheduler, however many worker tasks. `0` removes it. */
export async function scheduleCouponCustomerCheck(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: COUPON_CUSTOMER_CHECK_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
