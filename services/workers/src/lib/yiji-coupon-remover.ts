import { YijiRefusedError, YijiUnavailableError } from '@yiji/shared-types';

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
 *  - The CRM's own Yiji account (role "agent 1") is 403 on RemoveUserCoupon;
 *    the owner's admin token is not. So a bearer token may be configured
 *    (`YIJI_COUPON_REMOVE_TOKEN`); without it the service login is used and a
 *    403 is recorded as a refusal the screen can show - never retried.
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
  adminEmail?: string;
  adminPassword?: string;
  /** A fixed bearer (the owner's admin token) - preferred when set. */
  removeToken?: string;
  tenantId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const REMOVE_PATH = '/api/CouponUser/RemoveUserCoupon/';

/** Null when nothing is configured to talk to Yiji's admin API with. */
export function createYijiCouponRemover(env: YijiCouponRemoverEnv): YijiCouponRemover | null {
  const admin = env.adminApiUrl?.trim().replace(/\/+$/, '');
  const fixed = env.removeToken?.trim().replace(/^Bearer\s+/i, '') || '';
  const canLogin = !!(env.adminEmail?.trim() && env.adminPassword?.trim());
  if (!admin || (!fixed && !canLogin)) return null;
  const orderApi = env.apiUrl?.trim().replace(/\/+$/, '') || admin;
  const timeoutMs = env.timeoutMs ?? 10_000;
  const doFetch = env.fetchImpl ?? fetch;
  let loginToken: string | null = null;

  async function login(): Promise<string> {
    if (!canLogin) throw new YijiUnavailableError('the Yiji remove token was refused');
    const res = await timed(`${admin}/api/Account/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: env.adminEmail, password: env.adminPassword }),
    });
    if (!res.ok) throw new YijiUnavailableError(`admin login failed (${res.status})`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new YijiUnavailableError('admin login returned no token');
    loginToken = body.token;
    return body.token;
  }

  async function timed(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
      throw new YijiUnavailableError(`${reason} for ${url}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  /** One call, with one re-login on a 401 when the login credential exists. */
  async function call(url: string, method: 'GET' | 'DELETE'): Promise<Response> {
    let token = fixed || loginToken || (await login());
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await timed(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(env.tenantId ? { tenantid: env.tenantId } : {}),
        },
      });
      if (res.status === 401 && attempt === 0 && canLogin) {
        loginToken = null;
        token = await login();
        continue;
      }
      return res;
    }
    throw new YijiUnavailableError(`${method} ${url} refused the credential twice`);
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
