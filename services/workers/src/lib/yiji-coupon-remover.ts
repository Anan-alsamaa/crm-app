import {
  YijiLoginRefusedError,
  YijiRefusedError,
  YijiUnavailableError,
  isYijiLoginRefused,
  reportYijiUsage,
  yijiOperationFor,
  yijiUsageOutcome,
  type YijiUsageAccount,
  type YijiUsageSink,
} from '@yiji/shared-types';

/**
 * Taking a coupon grant BACK off a customer's Yiji account (owner, 2026-10-21,
 * EMA-80).
 *
 * The four Yiji calls the removal needs, and nothing else - the processor holds
 * this object, not a client, so it cannot wander into the rest of the API:
 *
 *   GET    /api/CouponUser/GetCouponByUser/{userId}        the wallet (unused)
 *   GET    /api/CouponUser/GetActiveCouponByUser/{userId}  what the app shows
 *   GET    {orderApi}/api/Order/GetOrderByUser/{userId}    was it SPENT?
 *   DELETE /api/CouponUser/RemoveUserCoupon/{grantId}      take it back
 *
 * Facts this is built on (memory: general-coupon-code-leak,
 * yiji-used-coupon-leaves-wallet):
 *  - RemoveUserCoupon's path says couponId but removes ONE GRANT, the CRM's
 *    `yiji_coupon_user_id`. It is a SOFT delete: gone from the customer's two
 *    lists, still counted in the admin list - so it is verified from the
 *    CUSTOMER's view, never from the admin list.
 *  - A coupon the customer SPENT leaves their wallet. An order's `couponId` is
 *    the grant id, so a spent coupon is found on their orders, not as missing.
 *
 * WHOSE CREDENTIAL (owner, 2026-10-21). Every call is made with the CRM's OWN
 * Yiji account first (the service login). The owner's admin token
 * (`YIJI_BACKUP_TOKEN`, formerly `YIJI_COUPON_REMOVE_TOKEN` - still read) is a
 * BACKUP, used for that one call only when the CRM account could not make it:
 * its login was refused, it was refused itself (401 after a re-login, or 403 -
 * the CRM's role "agent 1" is 403 on RemoveUserCoupon), or it is not
 * configured. A timeout or a network error never reaches the backup. Without
 * a backup a 403 is recorded as a refusal the screen can show - never retried.
 * Every call, and which account made it, goes to `onUsage`.
 */
export interface YijiCouponRemover {
  /** The Yiji user behind a CRM phone, or null when there is none / ambiguous. */
  findCustomer(phone: string): Promise<string | null>;
  /** Grant ids in the customer's wallet: every unused one, and the active ones. */
  wallet(userId: string): Promise<{ held: string[]; active: string[] }>;
  /** The order the grant was spent on, or null when it was never used. */
  usedOnOrder(userId: string, grantId: string): Promise<string | null>;
  /** Remove the grant. Throws YijiRefusedError on a settled "no". */
  removeGrant(grantId: string): Promise<void>;
}

export interface YijiCouponRemoverEnv {
  adminApiUrl?: string;
  /** The ORDER API host (GetOrderByUser lives there, not on the admin host). */
  apiUrl?: string;
  /** The CRM's own Yiji account - always tried first. */
  adminEmail?: string;
  adminPassword?: string;
  /** The owner's admin token: a BACKUP only (`YIJI_BACKUP_TOKEN`). */
  backupToken?: string;
  /** @deprecated The old name of `backupToken` (`YIJI_COUPON_REMOVE_TOKEN`); same meaning now. */
  removeToken?: string;
  tenantId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Told about every Yiji call (`yiji_api_usage`). */
  onUsage?: YijiUsageSink;
}

const REMOVE_PATH = '/api/CouponUser/RemoveUserCoupon/';

/** Null when nothing is configured to talk to Yiji's admin API with. */
export function createYijiCouponRemover(env: YijiCouponRemoverEnv): YijiCouponRemover | null {
  const admin = env.adminApiUrl?.trim().replace(/\/+$/, '');
  const backup =
    (env.backupToken?.trim() || env.removeToken?.trim() || '').replace(/^Bearer\s+/i, '') || '';
  const canLogin = !!(env.adminEmail?.trim() && env.adminPassword?.trim());
  if (!admin || (!backup && !canLogin)) return null;
  const orderApi = env.apiUrl?.trim().replace(/\/+$/, '') || admin;
  const timeoutMs = env.timeoutMs ?? 10_000;
  const doFetch = env.fetchImpl ?? fetch;
  let loginToken: string | null = null;

  async function login(): Promise<string> {
    const res = await timed(
      `${admin}/api/Account/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: env.adminEmail, password: env.adminPassword }),
      },
      'crm',
    );
    if (!res.ok) throw new YijiLoginRefusedError(`admin login failed (${res.status})`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new YijiLoginRefusedError('admin login returned no token');
    loginToken = body.token;
    return body.token;
  }

  /** One request, with its timeout, reported to `onUsage` whatever happens. */
  async function timed(
    url: string,
    init: RequestInit,
    account: YijiUsageAccount,
    fallbackReason: string | null = null,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const usage = { operation: yijiOperationFor(url), account, fallbackReason };
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      reportYijiUsage(env.onUsage, {
        ...usage,
        outcome: yijiUsageOutcome(res.status),
        httpStatus: res.status,
        durationMs: Date.now() - started,
        error: res.ok || res.status === 404 ? null : `HTTP ${res.status}`,
      });
      return res;
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
      reportYijiUsage(env.onUsage, {
        ...usage,
        outcome: 'error',
        httpStatus: null,
        durationMs: Date.now() - started,
        error: reason,
      });
      throw new YijiUnavailableError(`${reason} for ${url}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  /* A login Yiji REFUSED may go to the backup; a login that got no answer is thrown. */
  async function crmToken(): Promise<string | { fallback: string }> {
    if (loginToken) return loginToken;
    try {
      return await login();
    } catch (err) {
      if (!backup || !isYijiLoginRefused(err)) throw err;
      return { fallback: `crm login refused: ${(err as Error).message}` };
    }
  }

  /**
   * One call: the CRM account first (one re-login on a 401), then - only with
   * a backup token, and only for a refused login, a 401 after the re-login or
   * a 403 - the same call ONCE with the backup. Without a backup the CRM
   * account's answer is returned as it came, so a 403 stays a refusal.
   */
  async function call(url: string, method: 'GET' | 'DELETE'): Promise<Response> {
    const init = (token: string): RequestInit => ({
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(env.tenantId ? { tenantid: env.tenantId } : {}),
      },
    });
    const refusedAuth = (res: Response) => !!backup && (res.status === 401 || res.status === 403);

    let fallback = 'crm account not configured';
    if (canLogin) {
      const first = await crmToken();
      if (typeof first !== 'string') {
        fallback = first.fallback;
      } else {
        let res: Response | null = await timed(url, init(first), 'crm');
        let relogged = false;
        if (res.status === 401) {
          loginToken = null;
          const again = await crmToken();
          if (typeof again !== 'string') {
            fallback = again.fallback;
            res = null;
          } else {
            relogged = true;
            res = await timed(url, init(again), 'crm');
          }
        }
        if (res) {
          if (!refusedAuth(res)) return res;
          await res.body?.cancel().catch(() => undefined);
          fallback = `crm account refused (${res.status})${relogged ? ' after a re-login' : ''}`;
        }
      }
    }
    /* Reachable only with a backup token (the factory returns null without
       either credential, and every CRM branch above returns without one). */
    return timed(url, init(backup), 'backup', fallback);
  }

  async function readJson<T>(url: string): Promise<T | null> {
    const res = await call(url, 'GET');
    if (res.status === 404) return null;
    if (!res.ok) throw new YijiUnavailableError(`upstream ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  const ids = (rows: unknown): string[] =>
    (Array.isArray(rows) ? rows : [])
      .map((r) => (r as { id?: unknown })?.id)
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      .map((v) => String(v));

  return {
    async findCustomer(phone) {
      const national = (phone ?? '').replace(/\D/g, '').replace(/^966/, '').replace(/^0+/, '');
      if (national.length < 8) return null;
      const rows = await readJson<Array<{ id?: string; phoneNumber?: string | null }>>(
        `${admin}/api/User/GetfilteredCustomers?PhoneNumber=${encodeURIComponent(national)}`,
      );
      // EXACT +966 match only - two accounts can share the last 9 digits.
      const e164 = `966${national}`;
      const hits = [
        ...new Set(
          (rows ?? [])
            .filter((r) => (r?.phoneNumber ?? '').replace(/\D/g, '').replace(/^00/, '') === e164)
            .map((r) => r?.id?.trim())
            .filter((v): v is string => !!v),
        ),
      ];
      return hits.length === 1 ? hits[0]! : null;
    },
    async wallet(userId) {
      const u = encodeURIComponent(userId);
      const [held, active] = await Promise.all([
        readJson<unknown[]>(
          `${admin}/api/CouponUser/GetCouponByUser/${u}?PageNumber=1&PageSize=500`,
        ),
        readJson<unknown[]>(
          `${admin}/api/CouponUser/GetActiveCouponByUser/${u}?PageNumber=1&PageSize=500`,
        ),
      ]);
      return { held: ids(held), active: ids(active) };
    },
    async usedOnOrder(userId, grantId) {
      const orders = await readJson<
        Array<{ id?: unknown; orderNumber?: unknown; couponId?: unknown }>
      >(`${orderApi}/api/Order/GetOrderByUser/${encodeURIComponent(userId)}`);
      const hit = (orders ?? []).find(
        (o) => o?.couponId != null && String(o.couponId) === String(grantId),
      );
      if (!hit) return null;
      return String(hit.orderNumber ?? hit.id ?? '?');
    },
    async removeGrant(grantId) {
      const res = await call(`${admin}${REMOVE_PATH}${encodeURIComponent(grantId)}`, 'DELETE');
      const raw = await res.text().catch(() => '');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      if (res.status >= 400 && res.status < 500) {
        /* A 403 is the ROLE'S CEILING (the CRM's own account cannot remove);
           any 4xx is a settled answer - recorded, never retried. */
        throw new YijiRefusedError(
          `RemoveUserCoupon refused (${res.status})`,
          res.status,
          body ?? { status: res.status, text: raw.slice(0, 300) },
        );
      }
      if (!res.ok) throw new YijiUnavailableError(`RemoveUserCoupon upstream ${res.status}`);
      /* Yiji also refuses with a 200 whose `result` is not 1. */
      const result = (body as { result?: unknown } | null)?.result;
      if (typeof result === 'number' && result !== 1) {
        throw new YijiRefusedError('RemoveUserCoupon refused (result)', res.status, body);
      }
    },
  };
}
