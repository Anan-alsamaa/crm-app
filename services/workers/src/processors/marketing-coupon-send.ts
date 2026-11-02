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
import { describeRefusal, readNewCouponId, YIJI_ATTACH_BY_CODE_PATH } from './coupon-push.js';

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
  status: string;
  decided_at: string | null;
  yiji_coupon_id: string | null;
}

interface Recipient {
  id: string;
  phone: string;
}

type Fetch = typeof fetch;

/** Customers given a list coupon per run - two Yiji calls each, paced. */
const LIST_BATCH = 20;

export async function runMarketingCouponSend(deps: {
  directus: YijiDirectusClient;
  config: MarketingYijiConfig | null;
  logger: Logger;
  fetchImpl?: Fetch;
  pauseMs?: number;
}): Promise<{ created: number; failed: number; waiting: number; given: number }> {
  const { directus, config, logger } = deps;
  const f = deps.fetchImpl ?? fetch;
  const pause = deps.pauseMs ?? PAUSE_MS;
  const out = { created: 0, failed: 0, waiting: 0, given: 0 };
  if (!config) return out;

  const rows = (await directus.request(
    readItems(
      'marketing_coupons' as never,
      {
        filter: { status: { _in: ['approved', 'sending'] } },
        sort: ['decided_at'],
        limit: BATCH,
        fields: ['*'],
      } as never,
    ),
  )) as unknown as Row[];
  if (!rows.length) return out;

  /* One login per run. A refused login stops the run - every call would be
     refused the same way, and the work is safer waiting. */
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
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    tenantid: config.tenantId,
  };
  const wait = () => (pause > 0 ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve());
  const mark = (id: string, patch: Record<string, unknown>) =>
    directus.request(updateItem('marketing_coupons' as never, id, patch as never));

  /**
   * The list as the manager approved it: rows added AFTER the decision are
   * never sent to - a list cannot grow once it has been approved.
   */
  const listFilter = (row: Row, status?: string) => ({
    _and: [
      { coupon: { _eq: row.id } },
      ...(row.decided_at ? [{ date_created: { _lte: row.decided_at } }] : []),
      ...(status ? [{ status: { _eq: status } }] : []),
    ],
  });
  const countList = async (row: Row, status?: string): Promise<number> => {
    const r = (await directus.request(
      readItems(
        'marketing_coupon_recipients' as never,
        { filter: listFilter(row, status), aggregate: { count: ['id'] } } as never,
      ),
    )) as unknown as Array<{ count?: { id?: number | string } | number | string }>;
    const c = r[0]?.count;
    return Number(typeof c === 'object' && c ? c.id : c) || 0;
  };

  // 1. Create approved coupons on Yiji, once.
  let first = true;
  for (const row of rows.filter((r) => r.status === 'approved')) {
    if (!first) await wait();
    first = false;
    const problems = marketingCouponProblems(row);
    const listSize = row.audience === 'list' ? await countList(row) : 0;
    if (row.audience === 'list' && listSize === 0) problems.push('The list is empty.');
    if (problems.length) {
      await mark(row.id, { status: 'failed', send_error: `Not sent: ${problems.join(' ')}` });
      out.failed += 1;
      continue;
    }
    /* A list coupon may be used exactly as often as its list allows. */
    const draft =
      row.audience === 'list'
        ? { ...row, total_uses: listSize * (Number(row.uses_per_customer) || 1) }
        : row;
    let res: Response;
    try {
      res = await f(`${config.adminApiUrl}/api/Coupon/AddCoupon`, {
        method: 'POST',
        headers,
        body: JSON.stringify(marketingCouponPayload(draft)),
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
        // A list coupon still has to be handed to its customers.
        status: row.audience === 'list' ? 'sending' : 'created',
        yiji_coupon_id: String(couponId),
        sent_at: new Date().toISOString(),
        send_error: null,
        ...(row.audience === 'list' ? { recipient_count: listSize } : {}),
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

  // 2. Give ONE list coupon to the next few customers on its list.
  const sending = rows.find((r) => r.status === 'sending');
  if (sending) out.given = await giveToList(sending);
  return out;

  async function giveToList(row: Row): Promise<number> {
    const batch = (await directus.request(
      readItems(
        'marketing_coupon_recipients' as never,
        {
          filter: listFilter(row, 'queued'),
          sort: ['date_created'],
          limit: LIST_BATCH,
          fields: ['id', 'phone'],
        } as never,
      ),
    )) as unknown as Recipient[];
    const markR = (id: string, patch: Record<string, unknown>) =>
      directus.request(updateItem('marketing_coupon_recipients' as never, id, patch as never));
    let given = 0;
    for (const r of batch) {
      await wait();
      const national = r.phone.replace(/\D/g, '').replace(/^966/, '').replace(/^0+/, '');
      try {
        const look = await f(
          `${config!.adminApiUrl}/api/User/GetfilteredCustomers?PhoneNumber=${encodeURIComponent(national)}`,
          { headers },
        );
        if (look.status >= 500 || look.status === 429) break; // Yiji is struggling: stop here
        const users = ((await look.json().catch(() => [])) ?? []) as Array<{
          id?: string;
          phoneNumber?: string | null;
        }>;
        // EXACT +966 match only - two accounts can share the last 9 digits.
        const ids = [
          ...new Set(
            (Array.isArray(users) ? users : [])
              .filter(
                (u) =>
                  (u?.phoneNumber ?? '').replace(/\D/g, '').replace(/^00/, '') === `966${national}`,
              )
              .map((u) => u?.id?.trim())
              .filter((v): v is string => !!v),
          ),
        ];
        if (ids.length !== 1) {
          await markR(r.id, {
            status: 'no_account',
            error: ids.length ? 'More than one Yiji account has this number' : null,
          });
          continue;
        }
        const give = await f(
          `${config!.adminApiUrl}${YIJI_ATTACH_BY_CODE_PATH}/${encodeURIComponent(ids[0]!)}/${encodeURIComponent(row.code)}`,
          { method: 'POST', headers, body: '{}' },
        );
        if (give.status >= 500 || give.status === 429) break;
        const gb = (await give.json().catch(() => null)) as { result?: number } | null;
        if (give.ok && (gb?.result === undefined || Number(gb.result) === 1)) {
          await markR(r.id, {
            status: 'sent',
            yiji_user_id: ids[0],
            sent_at: new Date().toISOString(),
            error: null,
          });
          given += 1;
        } else {
          await markR(r.id, {
            status: 'failed',
            yiji_user_id: ids[0],
            error: `HTTP ${give.status}: ${describeRefusal(gb)}`,
          });
        }
      } catch (err) {
        logger.warn({ id: r.id, err: describeError(err) }, 'marketing list: no answer from Yiji');
        break; // left queued; the next run picks it up
      }
    }
    const [sent, none, failed, left] = await Promise.all([
      countList(row, 'sent'),
      countList(row, 'no_account'),
      countList(row, 'failed'),
      countList(row, 'queued'),
    ]);
    await mark(row.id, {
      sent_count: sent,
      no_account_count: none,
      failed_count: failed,
      ...(left === 0 ? { status: 'created' } : {}),
    });
    return given;
  }
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
