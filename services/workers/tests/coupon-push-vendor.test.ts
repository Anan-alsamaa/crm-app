import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  YijiConnector,
  type YijiClient,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { readCouponVendor, resolveCouponConnector } from '../src/processors/coupon-vendor.js';

/**
 * MV-1 (EMA-70): a coupon goes to the platform of the vendor its ROW names.
 * A vendor-less (pre-MV-1) row falls back to the legacy Yiji vendor - and says
 * so in the log. A vendor with no connector gets nothing.
 */

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function registry() {
  return new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { crmId: 'uuid-yiji', platformVendorId: '1', platform: 'yiji', status: 'active' },
      { crmId: 'uuid-two', platformVendorId: '2', platform: 'yiji', status: 'active' },
      { crmId: 'uuid-off', platformVendorId: '3', platform: 'yiji', status: 'inactive' },
    ]),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', client: {} }),
    legacyVendorKey: '1',
    factories: {
      yiji: (vendor, settings) => new YijiConnector(vendor, settings, { client: {} as YijiClient }),
    },
  });
}

describe('resolveCouponConnector', () => {
  it('uses the vendor the coupon row names', async () => {
    const log = logger();
    const c = await resolveCouponConnector({
      connectors: registry(),
      couponApprovalId: 'c-1',
      vendor: 'uuid-two',
      logger: log,
    });
    expect(c?.vendor.platformVendorId).toBe('2');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('falls back to the legacy Yiji vendor for a NULL vendor, and logs it', async () => {
    const log = logger();
    const c = await resolveCouponConnector({
      connectors: registry(),
      couponApprovalId: 'c-2',
      vendor: null,
      logger: log,
    });
    expect(c?.vendor.platformVendorId).toBe('1');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-2', legacyVendorId: '1' }),
      expect.stringContaining('no vendor'),
    );
  });

  it('sends nothing for a vendor with no connector (inactive / unknown) - never a guess', async () => {
    for (const vendor of ['uuid-off', 'uuid-nobody']) {
      const log = logger();
      const c = await resolveCouponConnector({
        connectors: registry(),
        couponApprovalId: 'c-3',
        vendor,
        logger: log,
      });
      expect(c, vendor).toBeNull();
      expect(log.error, vendor).toHaveBeenCalled();
    }
  });

  it('a different failure is not swallowed (the job retries)', async () => {
    const boom = new Error('directus down');
    await expect(
      resolveCouponConnector({
        connectors: {
          connectorFor: () => Promise.reject(boom),
          defaultVendorForLegacyRecords: async () => '1',
        },
        couponApprovalId: 'c-4',
        vendor: 'uuid-two',
        logger: logger(),
      }),
    ).rejects.toBe(boom);
  });
});

describe('readCouponVendor', () => {
  const directusAnswering = (impl: () => Promise<unknown>) =>
    ({ request: vi.fn(impl) }) as unknown as YijiDirectusClient;

  it('reads the vendor id, bare or expanded', async () => {
    expect(
      await readCouponVendor(
        directusAnswering(async () => ({ vendor: 'uuid-two' })),
        'c',
        logger(),
      ),
    ).toBe('uuid-two');
    expect(
      await readCouponVendor(
        directusAnswering(async () => ({ vendor: { id: 'uuid-yiji' } })),
        'c',
        logger(),
      ),
    ).toBe('uuid-yiji');
    expect(
      await readCouponVendor(
        directusAnswering(async () => ({ vendor: null })),
        'c',
        logger(),
      ),
    ).toBeNull();
  });

  it('an unreadable vendor (column not applied yet) is a legacy row, logged - not a failure', async () => {
    const log = logger();
    const v = await readCouponVendor(
      directusAnswering(async () => {
        throw new Error('403 FORBIDDEN');
      }),
      'c-5',
      log,
    );
    expect(v).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});
