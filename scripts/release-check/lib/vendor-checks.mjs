/**
 * PER-VENDOR RELEASE CHECKS (MV-6, EMA-75) — the PURE half.
 *
 * regressions.mjs runs these for EVERY active vendor; the decisions (what is a
 * pass, a fail, or a skip) live here with no I/O so they are tested
 * (packages/shared-types/tests/vendor-checks.test.ts).
 *
 * SKIP IS NOT PASS. A part that cannot be proven without an environment change
 * the owner has not approved yet (the test vendor's chat-login/webhook
 * secrets, ALLOW_MOCK_VENDORS on staging) reports SKIP with the exact variable
 * that is missing — never a pass, and never a fail that would block a release
 * on a change nobody has made.
 */
import { createHmac } from 'node:crypto';

/** Platforms with a connector. Mirrors COMMERCE_PLATFORMS in shared-types connector.ts. */
export const KNOWN_PLATFORMS = ['yiji', 'mock'];

/** An order and a customer that exist in MockConnector's fixtures (and never on Yiji). */
export const MOCK_PROBE_ORDER_ID = 'MOCK-1001';
export const MOCK_PROBE_PHONE = '0500000101';

/** Vendor-owned records probed for cross-vendor leaks. Read-only queries. */
export const ISOLATION_COLLECTIONS = ['contacts', 'conversations', 'tickets', 'coupon_approvals'];

/** How many of vendor A's ids one probe carries (a few hundred 414s at CloudFront). */
export const ISOLATION_SAMPLE = 50;

/** `vendors.platform`; NULL/blank reads as yiji, exactly as `vendorsFromRows` does. */
export function platformOf(vendor) {
  return String(vendor?.platform ?? '').trim() || 'yiji';
}

/** A row's vendor id, whether Directus returned it bare or expanded. */
export function vendorIdOfRow(row) {
  const v = row?.vendor;
  if (v && typeof v === 'object') return v.id ?? null;
  return v ?? null;
}

/**
 * Same convention as shared-types `vendorSecretEnvNames` (vendor-secrets.ts);
 * a test keeps the two in step.
 */
export function vendorSecretEnvNames(vendorKey) {
  const key = String(vendorKey ?? '')
    .trim()
    .toLowerCase();
  if (key === 'yiji') return { jwt: 'YIJI_JWT_SECRET', webhook: 'YIJI_WEBHOOK_SECRET' };
  const seg = key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { jwt: `VENDOR_${seg}_JWT_SECRET`, webhook: `VENDOR_${seg}_WEBHOOK_SECRET` };
}

/** Same scheme as the socket-gateway's `signWebhook`. */
export function signWebhook(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

const r = (status, detail) => ({ status, detail });

/**
 * (a) STATIC: can a connector serve this vendor at all? From the row alone.
 */
export function connectorVerdict(vendor, { env }) {
  const p = platformOf(vendor);
  if (!String(vendor?.yiji_vendor_id ?? '').trim()) {
    return r('FAIL', 'no yiji_vendor_id: the registry skips this vendor (every request 404s)');
  }
  if (!KNOWN_PLATFORMS.includes(p)) return r('FAIL', `platform "${p}" has no connector`);
  if (p === 'mock' && env === 'prod') {
    return r('FAIL', 'a MOCK (test) vendor is active on PRODUCTION - deactivate it');
  }
  return r('PASS', `platform ${p}`);
}

/**
 * (a) LIVE: the AI gateway's answer to `GET /commerce/order` for this vendor.
 *
 * Any answer but `404 unknown_vendor` means the registry RESOLVED the vendor
 * (the order itself may well not exist). For a mock vendor `unknown_vendor`
 * is the expected answer until ALLOW_MOCK_VENDORS=true is on the gateway, so
 * it is a SKIP naming that variable.
 */
export function classifyResolveProbe(vendor, httpStatus, body) {
  const p = platformOf(vendor);
  if (httpStatus === 404 && body?.error === 'unknown_vendor') {
    return p === 'mock'
      ? r(
          'SKIP',
          'mock vendor refused (expected until ALLOW_MOCK_VENDORS=true is on svc ai-gateway; also check the svc-ai-gateway vendors read includes `platform`)',
        )
      : r('FAIL', 'the AI gateway cannot resolve this vendor (404 unknown_vendor)');
  }
  if (httpStatus === 401 || httpStatus === 403)
    return r('FAIL', `HTTP ${httpStatus}: not allowed to ask`);
  if (httpStatus >= 500 && httpStatus !== 504) return r('FAIL', `HTTP ${httpStatus}`);
  return r('PASS', `resolved (HTTP ${httpStatus}${httpStatus === 504 ? ', upstream slow' : ''})`);
}

/**
 * (c) The mock vendor's order lookup returns MOCK data — an order id Yiji
 * cannot have (`MOCK-…`, Yiji's are numeric) — so it was never asked.
 */
export function classifyMockOrderProbe(httpStatus, body) {
  if (httpStatus === 404 && body?.error === 'unknown_vendor') {
    return r('SKIP', 'ALLOW_MOCK_VENDORS=true is not set on svc ai-gateway');
  }
  if (httpStatus !== 200) return r('FAIL', `HTTP ${httpStatus} ${body?.error ?? ''}`.trim());
  const o = body?.data;
  if (!o) return r('FAIL', 'no order: the mock connector did not answer');
  const mockish =
    o.orderId === MOCK_PROBE_ORDER_ID && /^Mock Kitchen/.test(String(o.restaurantName ?? ''));
  if (!mockish) {
    return r(
      'FAIL',
      `NOT mock data (orderId ${o.orderId}, ${o.restaurantName}) - was a real platform asked?`,
    );
  }
  const mods = (o.items ?? []).flatMap((i) => i.modifiers ?? []);
  return mods.length
    ? r(
        'PASS',
        `${o.orderId} from the mock, ${o.items.length} lines, modifiers: ${mods.join(', ')}`,
      )
    : r('FAIL', 'mock order carried no modifiers');
}

/** Ordered pairs (A, B), A != B, of vendors with a CRM id. */
export function isolationPairs(vendors) {
  const vs = (vendors ?? []).filter((v) => v?.id);
  const out = [];
  for (const a of vs) for (const b of vs) if (a.id !== b.id) out.push([a, b]);
  return out;
}

/** Rows returned under `vendor = B` that do NOT belong to B. */
export function filterLeaks(rows, vendorId) {
  return (rows ?? []).filter((row) => vendorIdOfRow(row) !== vendorId);
}

/**
 * (b) The probe: A's ids queried WITH `vendor = B` must return nothing, and
 * whatever `vendor = B` returns must be B's.
 */
export function isolationVerdict({ collection, a, b, sampled, crossRows, bRows }) {
  const label = `${collection}: ${a.name ?? a.id} vs ${b.name ?? b.id}`;
  const cross = crossRows ?? [];
  if (cross.length) {
    return r('FAIL', `${label}: ${cross.length} of A's rows returned under B's filter`);
  }
  const leaks = filterLeaks(bRows, b.id);
  if (leaks.length)
    return r('FAIL', `${label}: ${leaks.length} rows under B's filter belong elsewhere`);
  return r(
    'PASS',
    `${label}: ${sampled} of A's rows probed, none under B; ${(bRows ?? []).length} B rows all B's`,
  );
}

/**
 * The test vendor's customer chat login (`POST /chat/session` with its
 * vendorId). Signing a session token writes nothing; the conversation only
 * exists once a message is sent.
 */
export function classifyChatLoginProbe(vendorKey, httpStatus, body) {
  const { jwt } = vendorSecretEnvNames(vendorKey);
  if (httpStatus === 200 && body?.token)
    return r('PASS', 'session token minted with the vendor’s own secret');
  if (httpStatus === 503) return r('SKIP', `${jwt} is not set on svc socket-gateway`);
  if (httpStatus === 429) return r('SKIP', 'rate limited - re-run later');
  if (httpStatus === 404) return r('FAIL', 'the gateway does not know this vendor (404)');
  return r('FAIL', `HTTP ${httpStatus} ${body?.error ?? ''}`.trim());
}

/**
 * The test vendor's webhook. Unsigned must be REFUSED (401) once a secret is
 * configured; with the secret in the check's own env a signed ping must be
 * accepted (202). The receiver persists nothing.
 */
export function classifyWebhookProbe(vendorKey, httpStatus, { signed }) {
  const { webhook } = vendorSecretEnvNames(vendorKey);
  if (httpStatus === 503) return r('SKIP', `${webhook} is not set on svc socket-gateway`);
  if (httpStatus === 404) return r('FAIL', 'no active vendor with this webhook key (404)');
  if (signed) {
    return httpStatus === 202
      ? r('PASS', 'signed ping accepted')
      : r('FAIL', `signed ping: HTTP ${httpStatus}`);
  }
  return httpStatus === 401
    ? r('PASS', 'secret configured; an unsigned call is refused')
    : r('FAIL', `an UNSIGNED call got HTTP ${httpStatus} (expected 401)`);
}
