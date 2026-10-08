import { describe, expect, it } from 'vitest';
import {
  CachedVendorDirectory,
  vendorsFromRows,
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  UnknownVendorError,
  YijiConnector,
  createEnvConnectorRegistry,
  isUnknownVendor,
  type ConnectorVendor,
} from '../src/index.js';

const YIJI = { platform: 'yiji' as const, client: {} };

function registry(vendors: ConnectorVendor[]): ConnectorRegistry {
  return new ConnectorRegistry({
    directory: new StaticVendorDirectory(vendors),
    settings: new EnvVendorSettingsSource(YIJI),
  });
}

const yijiVendor: ConnectorVendor = {
  crmId: '6f1c-uuid',
  platformVendorId: '1',
  platform: 'yiji',
  status: 'active',
};

describe('ConnectorRegistry', () => {
  it('resolves a known vendor by its platform id to the Yiji connector', async () => {
    const c = await registry([yijiVendor]).connectorFor('1');
    expect(c).toBeInstanceOf(YijiConnector);
    expect(c.platform).toBe('yiji');
    expect(c.vendor.platformVendorId).toBe('1');
  });

  it('resolves the same vendor by its CRM UUID', async () => {
    const r = registry([yijiVendor]);
    const byUuid = await r.connectorFor('6f1c-uuid');
    // One connector per vendor, however it is addressed - so its clients'
    // cached admin tokens are shared, as the old process-wide singletons were.
    expect(byUuid).toBe(await r.connectorFor('1'));
  });

  it('refuses an unknown vendor with a typed error, never Yiji', async () => {
    const r = registry([yijiVendor]);
    const err = await r.connectorFor('2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownVendorError);
    expect(isUnknownVendor(err)).toBe(true);
    expect((err as UnknownVendorError).reason).toBe('unknown');
    expect((err as UnknownVendorError).vendorKey).toBe('2');
  });

  it('refuses an empty vendor key', async () => {
    await expect(registry([yijiVendor]).connectorFor('  ')).rejects.toMatchObject({
      reason: 'unknown',
    });
  });

  it('refuses an inactive vendor', async () => {
    const r = registry([{ ...yijiVendor, status: 'archived' }]);
    await expect(r.connectorFor('1')).rejects.toMatchObject({ reason: 'inactive' });
  });

  it('refuses a vendor on a platform with no connector', async () => {
    const r = registry([{ ...yijiVendor, platform: 'shopify' as never }]);
    await expect(r.connectorFor('1')).rejects.toMatchObject({ reason: 'unsupported_platform' });
  });

  describe('defaultVendorForLegacyRecords', () => {
    it('is the single active Yiji vendor', async () => {
      const r = registry([yijiVendor, { ...yijiVendor, platformVendorId: '9', status: 'x' }]);
      expect(await r.defaultVendorForLegacyRecords()).toBe('1');
    });

    it('REFUSES once a second active Yiji vendor exists - no guessing', async () => {
      const r = registry([yijiVendor, { ...yijiVendor, crmId: 'b', platformVendorId: '2' }]);
      await expect(r.defaultVendorForLegacyRecords()).rejects.toMatchObject({
        reason: 'ambiguous_legacy_default',
      });
    });

    it('refuses when there is no active Yiji vendor', async () => {
      await expect(registry([]).defaultVendorForLegacyRecords()).rejects.toMatchObject({
        reason: 'no_legacy_default',
      });
    });
  });

  it('does not cache a failed build', async () => {
    let calls = 0;
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([yijiVendor]),
      settings: {
        async settingsFor() {
          calls += 1;
          if (calls === 1) throw new Error('settings store down');
          return YIJI;
        },
      },
    });
    await expect(r.connectorFor('1')).rejects.toThrow('settings store down');
    await expect(r.connectorFor('1')).resolves.toBeInstanceOf(YijiConnector);
  });
});

describe('vendors table directory (ai-gateway: portals send UUID AND yiji_vendor_id)', () => {
  const UUID = '0b6f9a52-7c1e-4a8e-9f3e-2f6d1c0a9e11';
  const rows = [
    { id: UUID, yiji_vendor_id: '1', status: 'active', name: 'Yiji' },
    { id: 'demo-uuid', yiji_vendor_id: 'demo-okashi', status: 'active', name: 'Okashi' },
    { id: 'old-uuid', yiji_vendor_id: 'old', status: 'archived' },
    { id: 'no-platform-id', yiji_vendor_id: null, status: 'active' },
  ];

  function dbRegistry(load: () => Promise<ConnectorVendor[]>, onDirectoryFallback?: () => void) {
    return createEnvConnectorRegistry({
      yiji: { client: {} },
      loadVendors: load,
      ...(onDirectoryFallback ? { onDirectoryFallback } : {}),
    });
  }

  it('resolves the CRM UUID and "1" to the SAME connector', async () => {
    const r = dbRegistry(async () => vendorsFromRows(rows));
    const byUuid = await r.connectorFor(UUID);
    expect(byUuid).toBe(await r.connectorFor('1'));
    expect(byUuid).toBeInstanceOf(YijiConnector);
  });

  it('still refuses a vendor the table does not hold, and an inactive one', async () => {
    const r = dbRegistry(async () => vendorsFromRows(rows));
    await expect(r.connectorFor('nope')).rejects.toMatchObject({ reason: 'unknown' });
    await expect(r.connectorFor('old-uuid')).rejects.toMatchObject({ reason: 'inactive' });
    await expect(r.connectorFor('no-platform-id')).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('pins legacy records to the env vendor even with several active vendors', async () => {
    const r = dbRegistry(async () => vendorsFromRows(rows));
    expect(await r.defaultVendorForLegacyRecords()).toBe('1');
  });

  it('a failed read falls back to the env vendor and SAYS so', async () => {
    const warned: unknown[] = [];
    const r = dbRegistry(
      async () => {
        throw new Error('403 FORBIDDEN');
      },
      () => warned.push('fallback'),
    );
    // '1' keeps working: a Directus hiccup is not a commerce outage.
    await expect(r.connectorFor('1')).resolves.toBeInstanceOf(YijiConnector);
    expect(await r.defaultVendorForLegacyRecords()).toBe('1');
    // A UUID cannot be resolved from env alone - an honest 404, not a guess.
    await expect(r.connectorFor(UUID)).rejects.toMatchObject({ reason: 'unknown' });
    expect(warned.length).toBeGreaterThan(0);
  });

  it('an EMPTY read is a failure, not "no vendors"', async () => {
    let fellBack = false;
    const r = dbRegistry(
      async () => [],
      () => {
        fellBack = true;
      },
    );
    await expect(r.connectorFor('1')).resolves.toBeInstanceOf(YijiConnector);
    expect(fellBack).toBe(true);
  });
});

describe('CachedVendorDirectory', () => {
  const env = new StaticVendorDirectory([{ ...yijiVendor, crmId: undefined }]);
  const db: ConnectorVendor[] = [yijiVendor];

  it('caches a good read for the TTL and re-reads after it', async () => {
    let t = 0;
    let reads = 0;
    const dir = new CachedVendorDirectory({
      load: async () => {
        reads += 1;
        return db;
      },
      fallback: env,
      ttlMs: 1000,
      now: () => t,
    });
    await dir.list();
    await dir.list();
    expect(reads).toBe(1);
    t = 1500;
    await dir.list();
    expect(reads).toBe(2);
  });

  it('serves the LAST GOOD list when a refresh fails, and backs off before retrying', async () => {
    let t = 0;
    let fail = false;
    let reads = 0;
    const errors: unknown[] = [];
    const dir = new CachedVendorDirectory({
      load: async () => {
        reads += 1;
        if (fail) throw new Error('directus down');
        return db;
      },
      fallback: env,
      ttlMs: 1000,
      retryMs: 500,
      onFallback: (e) => errors.push(e),
      now: () => t,
    });
    expect(await dir.list()).toEqual(db);
    fail = true;
    t = 2000;
    expect(await dir.list()).toEqual(db); // last good, UUID still resolvable
    expect(errors).toHaveLength(1);
    t = 2200; // inside the back-off: no new read
    await dir.list();
    expect(reads).toBe(2);
    fail = false;
    t = 2600;
    await dir.list();
    expect(reads).toBe(3);
  });

  it('coalesces concurrent reads into one', async () => {
    let reads = 0;
    const dir = new CachedVendorDirectory({
      load: async () => {
        reads += 1;
        return db;
      },
      fallback: env,
    });
    await Promise.all([dir.list(), dir.list(), dir.list()]);
    expect(reads).toBe(1);
  });
});

describe('createEnvConnectorRegistry (today: one vendor, settings from env)', () => {
  it("defaults the vendor to '1', the id the Yiji app sends", async () => {
    const r = createEnvConnectorRegistry({ yiji: { client: {} } });
    expect(await r.defaultVendorForLegacyRecords()).toBe('1');
    await expect(r.connectorFor('1')).resolves.toBeInstanceOf(YijiConnector);
    await expect(r.connectorFor('demo-okashi')).rejects.toBeInstanceOf(UnknownVendorError);
  });

  it('uses the configured vendor id, and only that one', async () => {
    const r = createEnvConnectorRegistry({ vendorId: '7', yiji: { client: {} } });
    expect(await r.defaultVendorForLegacyRecords()).toBe('7');
    await expect(r.connectorFor('1')).rejects.toBeInstanceOf(UnknownVendorError);
  });

  it('exposes capabilities as null exactly when the factories would return null', async () => {
    const bare = await createEnvConnectorRegistry({ yiji: { client: {} } }).connectorFor('1');
    expect(bare.adminPost).toBeNull();
    expect(bare.findCustomerIdByPhone).toBeNull();
    expect(bare.getCustomerProfile).toBeNull();
    expect(bare.findCustomerCoupon).toBeNull();
    expect(bare.readCouponOrderContext).toBeNull();
    expect(bare.latestOrderId).toBeNull();
    expect(bare.latestOrderBrandName).toBeNull();

    const full = await createEnvConnectorRegistry({
      yiji: {
        client: {
          apiUrl: 'https://order.example',
          adminApiUrl: 'https://admin.example',
          adminEmail: 'svc@example.com',
          adminPassword: 'pw',
        },
      },
    }).connectorFor('1');
    expect(full.adminPost).toBeTypeOf('function');
    expect(full.findCustomerIdByPhone).toBeTypeOf('function');
    expect(full.getCustomerProfile).toBeTypeOf('function');
    expect(full.findCustomerCoupon).toBeTypeOf('function');
    expect(full.readCouponOrderContext).toBeTypeOf('function');
    expect(full.latestOrderId).toBeTypeOf('function');
    expect(full.latestOrderBrandName).toBeTypeOf('function');
  });

  it('carries the raw platform settings through unchanged', async () => {
    const c = await createEnvConnectorRegistry({
      yiji: { client: {}, tenantId: '', brandId: '3', push: { notifyTopic: '12' } },
    }).connectorFor('1');
    expect(c.settings).toEqual({
      platform: 'yiji',
      client: {},
      tenantId: '',
      brandId: '3',
      push: { notifyTopic: '12' },
    });
  });
});
