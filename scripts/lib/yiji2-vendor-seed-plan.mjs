/**
 * The PURE half of scripts/seed-yiji2-vendor.mjs (owner, 2026-11-16: Yiji v2
 * as a second tenant, implemented but NOT activated). Given what the
 * database holds, decide what to write. No I/O, so it is tested
 * (packages/shared-types/tests/yiji2-vendor-seed.test.ts).
 *
 * Rules it enforces:
 *  - ONE ROW, INACTIVE. The v2 vendor is created with status `inactive` and
 *    is NEVER activated by this script: activation is the owner's act, in
 *    the Vendors page, staging first.
 *  - NEVER TOUCHES V1. The Yiji vendor row (platform `yiji`, id `1`) is not
 *    read for writing, not updated, not deleted.
 *  - NEVER ADOPTS A REAL VENDOR. A row already holding the v2 platform id or
 *    the `yiji2` webhook key that is not on the `yiji2` platform is refused.
 *  - IDEMPOTENT. Found by its natural keys; only drifted NON-STATUS fields
 *    are written, so a re-run after the owner activated it does not switch it
 *    off again, and never writes a credential (there is none in the row).
 *  - NO DELETE. There is no --remove: deleting a vendor cascades to its
 *    contacts, conversations and tickets (docs/MULTI-VENDOR.md).
 *  - NOT PRODUCTION unless told. The default hosts are local and staging;
 *    `--allow-prod` is the explicit word for crm-api.anan.sa.
 */

export const PROD_API_HOST = 'crm-api.anan.sa';

/** The row the brief proposes (section 2 and 7.2); the owner confirms the id and key. */
export const YIJI2_VENDOR = Object.freeze({
  name: 'Yiji V2',
  platform: 'yiji2',
  yiji_vendor_id: '2',
  webhook_path_key: 'yiji2',
  /* Placeholder host from the brief; the real staging/prod host is set on the Vendors page. */
  api_base_url: 'https://api.staging.yiji.app',
  admin_api_url: null,
  tenant_id: null,
  status: 'inactive',
  colors: { primary: '#1F6FEB', secondary: '#F2B705' },
});

/**
 * The fields a re-run may correct: the IDENTITY of the row only. `status`,
 * `name`, `colors` and `api_base_url` are the owner's once the row exists
 * (review 2026-11-16: a re-run after activation reset the real host to the
 * placeholder, and the prod credentials would have gone to it). The host is
 * filled in only when the row has none.
 */
const MANAGED_FIELDS = ['platform', 'webhook_path_key'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Throws for production unless explicitly allowed. */
export function assertAllowedApi(api, { allowProd = false } = {}) {
  let host = '';
  try {
    host = new URL(String(api ?? '')).host.toLowerCase();
  } catch {
    /* fall through */
  }
  if (!host) throw new Error(`refusing: "${api}" is not a URL`);
  if (host === PROD_API_HOST && !allowProd) {
    throw new Error(
      `refusing: ${PROD_API_HOST} is production. The v2 vendor row goes to production only on the owner's word (--allow-prod).`,
    );
  }
  return host;
}

/**
 * What --write would do.
 *
 * @param {{ vendors: Array<Record<string, unknown>> }} state every vendors row
 *   (id, name, platform, yiji_vendor_id, webhook_path_key, api_base_url, status, colors)
 * @returns {{ refuse: string } | { actions: Array<{ op: 'create'|'update'|'none', collection: 'vendors', id?: string, key: string, data?: object, note?: string }> }}
 */
export function planYiji2Seed({ vendors }) {
  const rows = vendors ?? [];
  const byId = rows.find((v) => String(v.yiji_vendor_id ?? '') === YIJI2_VENDOR.yiji_vendor_id);
  const byKey = rows.find((v) => v.webhook_path_key === YIJI2_VENDOR.webhook_path_key);
  for (const v of [byId, byKey]) {
    if (v && (v.platform ?? 'yiji') !== 'yiji2') {
      return {
        refuse: `vendor "${v.name}" (${v.id}) already holds ${v === byId ? `yiji_vendor_id ${YIJI2_VENDOR.yiji_vendor_id}` : `webhook key "${YIJI2_VENDOR.webhook_path_key}"`} and is NOT on the yiji2 platform - refusing to touch another platform's vendor`,
      };
    }
  }
  if (byId && byKey && byId.id !== byKey.id) {
    return {
      refuse: `yiji_vendor_id ${YIJI2_VENDOR.yiji_vendor_id} and webhook key "${YIJI2_VENDOR.webhook_path_key}" belong to two different vendors - fix by hand`,
    };
  }
  const vendor = byId ?? byKey ?? null;
  if (!vendor) {
    return {
      actions: [
        {
          op: 'create',
          collection: 'vendors',
          key: YIJI2_VENDOR.yiji_vendor_id,
          data: { ...YIJI2_VENDOR },
          note: 'created INACTIVE; the owner activates it on the Vendors page (staging first)',
        },
      ],
    };
  }
  const data = {};
  for (const k of MANAGED_FIELDS) {
    if (!same(vendor[k], YIJI2_VENDOR[k])) data[k] = YIJI2_VENDOR[k];
  }
  if (!String(vendor.api_base_url ?? '').trim()) data.api_base_url = YIJI2_VENDOR.api_base_url;
  if (!Object.keys(data).length) {
    return {
      actions: [
        {
          op: 'none',
          collection: 'vendors',
          id: vendor.id,
          key: YIJI2_VENDOR.yiji_vendor_id,
          note: `already present (status ${vendor.status ?? 'unknown'} - left as it is)`,
        },
      ],
    };
  }
  return {
    actions: [
      {
        op: 'update',
        collection: 'vendors',
        id: vendor.id,
        key: YIJI2_VENDOR.yiji_vendor_id,
        data,
        note: `status ${vendor.status ?? 'unknown'} left as it is`,
      },
    ],
  };
}

/**
 * The env variable names the deployment needs for this row, per service, so
 * the owner has the list in one place (values are never in the repo).
 */
export function yiji2EnvNames(key = YIJI2_VENDOR.webhook_path_key) {
  const seg = String(key)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
  return {
    'socket-gateway': [
      `VENDOR_${seg}_JWT_SECRET`,
      `VENDOR_${seg}_WEBHOOK_SECRET`,
      'YIJI2_VENDOR_ID',
    ],
    'ai-gateway': [`VENDOR_${seg}_CLIENT_ID`, `VENDOR_${seg}_CLIENT_SECRET`],
    workers: [`VENDOR_${seg}_CLIENT_ID`, `VENDOR_${seg}_CLIENT_SECRET`],
  };
}
