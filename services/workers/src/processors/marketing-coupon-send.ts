import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  marketingCouponPayload,
  marketingCouponProblems,
  type MarketingCouponDraft,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';
import { describeRefusal, readNewCouponId } from './coupon-push.js';

/**
 * MARKETING COUPONS -> YIJI (owner, 2026-11-02).
 *
 * Every few minutes: the coupons a marketing manager APPROVED are created on
 * Yiji with `POST /api/Coupon/AddCoupon`, one at a time, a pause between - a
 * scheduled trickle, never a burst (incident 2026-10-26).
 *
 * WITH THE MARKETING YIJI ACCOUNT ONLY (owner's decision): until
 * `YIJI_MARKETING_EMAIL` and `YIJI_MARKETING_PASSWORD` are set, this does
 * nothing and approved coupons wait, saying so in the portal. Staging never
 * gets those settings - it shares Yiji's production, so a test there would be
 * a real coupon.
 *
 * ONCE: a coupon is created and then never touched again on Yiji. An edit
 * drops it from Yiji's IssuedCopouns report (2026-11-01).
 */

export const MARKETING_COUPON_SEND_JOB = 'marketing-coupon-send';
export const DEFAULT_MARKETING_COUPON_SEND_MS = 120_000;
const SCHEDULER = 'marketing-coupon-send';
const BATCH = 10;
const PAUSE_MS = 2_000;

export interface MarketingYijiConfig {
  adminApiUrl: string;
  email: string;
  password: string;
  tenantId: string;
}

/** The marketing Yiji login, or null when it is not configured (= off). */
export function marketingYijiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MarketingYijiConfig | null {
  const adminApiUrl = env.YIJI_ADMIN_API_URL?.trim();
  const email = env.YIJI_MARKETING_EMAIL?.trim();
  const password = env.YIJI_MARKETING_PASSWORD?.trim();
  if (!adminApiUrl || !email || !password) return null;
  return {
    adminApiUrl: adminApiUrl.replace(/\/+$/, ''),
    email,
    password,
    tenantId: env.YIJI_TENANT_ID || '1',
  };
}

interface Row extends MarketingCouponDraft {
  id: string;
}

type Fetch = typeof fetch;

export async function runMarketingCouponSend(deps: {
  directus: YijiDirectusClient;
  config: MarketingYijiConfig | null;
  logger: Logger;
  fetchImpl?: Fetch;
  pauseMs?: number;
}): Promise<{ created: number; failed: number; waiting: number }> {
  const { directus, config, logger } = deps;
  const f = deps.fetchImpl ?? fetch;
  const pause = deps.pauseMs ?? PAUSE_MS;
  const out = { created: 0, failed: 0, waiting: 0 };
  if (!config) return out;

  const rows = (await directus.request(
    readItems(
      'marketing_coupons' as never,
      {
        filter: { status: { _eq: 'approved' } },
        sort: ['decided_at'],
        limit: BATCH,
        fields: ['*'],
      } as never,
    ),
  )) as unknown as Row[];
  if (!rows.length) return out;

  /* One login per run. A refused login stops the run - every coupon would be
     refused the same way, and they are safer waiting as `approved`. */
  let token: string;
  try {
    const res = await f(`${config.adminApiUrl}/api/Account/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    if (!res.ok || !body.token) throw new Error(`login refused (${res.status})`);
    token = body.token;
  } catch (err) {
    logger.warn({ err: describeError(err) }, 'marketing Yiji login failed - coupons wait');
    out.waiting = rows.length;
    return out;
  }

  const mark = (id: string, patch: Record<string, unknown>) =>
    directus.request(updateItem('marketing_coupons' as never, id, patch as never));

  for (const [i, row] of rows.entries()) {
    if (i > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
    const problems = marketingCouponProblems(row);
    if (problems.length) {
      await mark(row.id, { status: 'failed', send_error: `Not sent: ${problems.join(' ')}` });
      out.failed += 1;
      continue;
    }
    let res: Response;
    try {
      res = await f(`${config.adminApiUrl}/api/Coupon/AddCoupon`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          tenantid: config.tenantId,
        },
        body: JSON.stringify(marketingCouponPayload(row)),
      });
    } catch (err) {
      /* No answer: we do not know whether Yiji made it, so it stays approved
         and the next run tries again - Yiji refuses a duplicate code. */
      logger.warn({ id: row.id, err: describeError(err) }, 'marketing coupon: no answer from Yiji');
      out.waiting += 1;
      continue;
    }
    if (res.status >= 500 || res.status === 429) {
      out.waiting += 1;
      continue;
    }
    const body = (await res.json().catch(() => null)) as Parameters<typeof readNewCouponId>[0];
    const couponId = res.ok ? readNewCouponId(body) : null;
    if (couponId) {
      await mark(row.id, {
        status: 'created',
        yiji_coupon_id: String(couponId),
        sent_at: new Date().toISOString(),
        send_error: null,
      });
      out.created += 1;
      logger.info({ id: row.id, code: row.code, couponId }, 'marketing coupon created on Yiji');
    } else {
      await mark(row.id, {
        status: 'failed',
        send_error: `Yiji refused it (HTTP ${res.status}): ${describeRefusal(body)}`,
      });
      out.failed += 1;
      logger.warn(
        { id: row.id, code: row.code, status: res.status },
        'marketing coupon refused by Yiji',
      );
    }
  }
  return out;
}

export async function scheduleMarketingCouponSend(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: MARKETING_COUPON_SEND_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
