import { describe, expect, it, vi } from 'vitest';
import {
  ConnectorRegistry,
  RecordVendorSettingsSource,
  StaticVendorDirectory,
  vendorCredentialEnvNames,
  vendorCredentialsFromEnv,
  type ConnectorVendor,
  type VendorIntegrationRow,
  type YijiPlatformSettings,
} from '../src/index.js';

/**
 * MV-7: each vendor's NON-SECRET settings come from its record, env behind it
 * per field; credentials come from env only, and never cross vendors.
 */
const ENV: YijiPlatformSettings = {
  platform: 'yiji',
  client: {
    apiUrl: 'https://order.env',
    token: 'yiji-key',
    adminApiUrl: 'https://admin.env',
    adminEmail: 'yiji@svc',
    adminPassword: 'yiji-pw',
  },
  tenantId: '1',
  brandId: '1',
  push: {
    notifyUrl: 'https://notify.env',
    notifyTopic: '5',
    notifyTitle: 'Yiji Support',
    openChatAction: 'crm.openchat',
    apiKey: 'yiji-key',
  },
};

const yiji: ConnectorVendor = {
  crmId: 'u-yiji',
  platformVendorId: '1',
  platform: 'yiji',
  status: 'active',
};
const acme: ConnectorVendor = {
  crmId: 'u-acme',
  platformVendorId: '42',
  platform: 'yiji',
  status: 'active',
};

const ACME_ENV = {
  VENDOR_ACME_FOODS_API_KEY: 'acme-key',
  VENDOR_ACME_FOODS_ADMIN_EMAIL: 'acme@svc',
  VENDOR_ACME_FOODS_ADMIN_PASSWORD: 'acme-pw',
  YIJI_ADMIN_PASSWORD: 'must-not-be-used',
};

function source(
  rows: VendorIntegrationRow[] | (() => Promise<VendorIntegrationRow[]>),
  extra = {},
) {
  return new RecordVendorSettingsSource({
    env: ENV,
    legacyVendorKey: '1',
    load: typeof rows === 'function' ? rows : async () => rows,
    credentialEnv: ACME_ENV,
    ...extra,
  });
}

describe('credential env names (MV-7)', () => {
  it('Yiji keeps YIJI_*; others VENDOR_<KEY>_*', () => {
    expect(vendorCredentialEnvNames('yiji')).toEqual({
      apiKey: 'YIJI_API_KEY',
      adminEmail: 'YIJI_ADMIN_EMAIL',
      adminPassword: 'YIJI_ADMIN_PASSWORD',
    });
    expect(vendorCredentialEnvNames('acme-foods')).toEqual({
      apiKey: 'VENDOR_ACME_FOODS_API_KEY',
      adminEmail: 'VENDOR_ACME_FOODS_ADMIN_EMAIL',
      adminPassword: 'VENDOR_ACME_FOODS_ADMIN_PASSWORD',
    });
  });

  it('blank or invalid keys read nothing', () => {
    expect(vendorCredentialsFromEnv({ VENDOR_X_API_KEY: '  ' }, 'x')).toEqual({});
    expect(vendorCredentialsFromEnv(ACME_ENV, '../etc')).toEqual({});
  });
});

describe('RecordVendorSettingsSource', () => {
  it('Yiji: record URLs/tenant/brand/notify win, credentials stay env', async () => {
    const s = await source([
      {
        id: 'u-yiji',
        yiji_vendor_id: '1',
        api_base_url: 'https://order.rec',
        admin_api_url: 'https://admin.rec',
        tenant_id: '7',
        brand_id: '9',
        notify_settings: { notifyTitle: 'Rec Support' },
      },
    ]).settingsFor(yiji);
    expect(s).toEqual({
      platform: 'yiji',
      client: { ...ENV.client, apiUrl: 'https://order.rec', adminApiUrl: 'https://admin.rec' },
      tenantId: '7',
      brandId: '9',
      push: { ...ENV.push, notifyTitle: 'Rec Support' },
    });
  });

  it('blank record fields fall back to env, field by field', async () => {
    const s = await source([
      { id: 'u-yiji', api_base_url: '  ', admin_api_url: null, tenant_id: '', brand_id: null },
    ]).settingsFor(yiji);
    expect(s).toEqual(ENV);
  });

  it('another vendor gets ITS OWN VENDOR_<KEY>_* credentials, never Yiji’s', async () => {
    const s = (await source([
      { id: 'u-acme', webhook_path_key: 'acme-foods', api_base_url: 'https://acme.rec' },
    ]).settingsFor(acme)) as YijiPlatformSettings;
    expect(s.client).toEqual({
      apiUrl: 'https://acme.rec',
      adminApiUrl: 'https://admin.env',
      token: 'acme-key',
      adminEmail: 'acme@svc',
      adminPassword: 'acme-pw',
    });
    expect(s.push?.apiKey).toBe('acme-key');
    expect(JSON.stringify(s)).not.toContain('yiji-pw');
    expect(JSON.stringify(s)).not.toContain('yiji-key');
  });

  it('a vendor with no key/credentials has none (no Yiji fallback)', async () => {
    const s = (await source([{ id: 'u-acme' }]).settingsFor(acme)) as YijiPlatformSettings;
    expect(s.client.adminEmail).toBeUndefined();
    expect(s.client.adminPassword).toBeUndefined();
    expect(s.client.token).toBeUndefined();
    expect(s.push?.apiKey).toBeUndefined();
  });

  it('a failed read answers env settings and reports it; last good rows survive', async () => {
    let t = 0;
    let fail = false;
    const onFallback = vi.fn();
    const src = source(
      async () => {
        if (fail) throw new Error('403');
        return [{ id: 'u-yiji', api_base_url: 'https://order.rec' }];
      },
      { onFallback, now: () => t, ttlMs: 10 },
    );
    fail = true;
    expect(await src.settingsFor(yiji)).toEqual(ENV);
    expect(onFallback).toHaveBeenCalledTimes(1);
    fail = false;
    t = 100_000; // past the retry window
    expect(((await src.settingsFor(yiji)) as YijiPlatformSettings).client.apiUrl).toBe(
      'https://order.rec',
    );
    fail = true;
    t = 200_000; // past the TTL: the read fails, the last good rows answer
    expect(((await src.settingsFor(yiji)) as YijiPlatformSettings).client.apiUrl).toBe(
      'https://order.rec',
    );
    expect(onFallback).toHaveBeenCalledTimes(2);
  });

  it('mock stays refused without allowMock', async () => {
    const mock: ConnectorVendor = { platformVendorId: 't', platform: 'mock', status: 'active' };
    await expect(source([]).settingsFor(mock)).rejects.toMatchObject({
      reason: 'mock_not_allowed',
    });
    expect(await source([], { allowMock: true }).settingsFor(mock)).toEqual({ platform: 'mock' });
  });
});

describe('ConnectorRegistry with record settings', () => {
  it('reuses the connector while settings are unchanged, rebuilds when they change', async () => {
    let url = 'https://order.rec';
    let t = 0;
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([yiji]),
      settings: source(async () => [{ id: 'u-yiji', api_base_url: url }], {
        now: () => t,
        ttlMs: 10,
      }),
    });
    const a = await r.connectorFor('1');
    expect(await r.connectorFor('u-yiji')).toBe(a);
    url = 'https://order.changed';
    t = 100;
    const b = await r.connectorFor('1');
    expect(b).not.toBe(a);
    expect((b.settings as YijiPlatformSettings).client.apiUrl).toBe('https://order.changed');
  });
});
