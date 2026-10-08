import type { Logger } from 'pino';
import { readItem } from '@directus/sdk';
import { isUnknownVendor, vendorIdOf } from '@yiji/shared-types';
import type { ConnectorRegistry, VendorConnector, VendorRef } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';

/**
 * WHOSE PLATFORM A COUPON GOES TO (MV-1, EMA-70).
 *
 * The coupon row names its vendor (`coupon_approvals.vendor`, the CRM UUID),
 * and that vendor's connector delivers it. Nothing else about the push
 * changes: the same connector, the same poster, the same payload.
 *
 * A row with NO vendor was written before MV-1 (or by a portal bundle still
 * parked behind "Update now") and is the legacy Yiji vendor's - exactly what
 * every coupon was before. That fallback is LOGGED, so the day it stops
 * happening is visible and the fallback can be deleted.
 *
 * A vendor the registry cannot serve (unknown, inactive, no connector) gets
 * NOTHING: the coupon is not sent anywhere and stays `approved`, which the
 * delivery sweep re-queues once the vendor resolves. Sending one vendor's
 * coupon through another vendor's platform is the failure this layer exists
 * to make impossible, and it cannot be taken back.
 */
export type CouponConnectors = Pick<
  ConnectorRegistry,
  'connectorFor' | 'defaultVendorForLegacyRecords'
>;

/** The coupon row's vendor id, or null for a legacy (vendor-less) row. */
export async function readCouponVendor(
  directus: YijiDirectusClient,
  couponApprovalId: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const row = (await directus.request(
      readItem('coupon_approvals' as never, couponApprovalId, { fields: ['vendor'] } as never),
    )) as unknown as { vendor?: VendorRef };
    return vendorIdOf(row?.vendor);
  } catch (err) {
    /* Not fatal, and not a guess either: a row whose vendor cannot be read
       (the column not applied yet, or a blip the main read will retry) is
       treated exactly as before MV-1. The processor's own re-read of the row
       still decides whether anything is sent. */
    logger.warn(
      { id: couponApprovalId, err: describeError(err) },
      'could not read the coupon vendor - treating it as a legacy row',
    );
    return null;
  }
}

/**
 * The connector for this coupon, or null when its vendor cannot be served
 * (already logged; the caller sends nothing).
 */
export async function resolveCouponConnector(args: {
  connectors: CouponConnectors;
  couponApprovalId: string;
  vendor: string | null;
  logger: Logger;
}): Promise<VendorConnector | null> {
  const { connectors, couponApprovalId: id, vendor, logger } = args;
  try {
    if (vendor) return await connectors.connectorFor(vendor);
    const legacy = await connectors.defaultVendorForLegacyRecords();
    logger.info(
      { id, legacyVendorId: legacy },
      'coupon has no vendor - using the legacy Yiji vendor (pre-MV-1 row)',
    );
    return await connectors.connectorFor(legacy);
  } catch (err) {
    if (!isUnknownVendor(err)) throw err;
    logger.error(
      { id, vendor, reason: err.reason },
      'coupon for a vendor with no connector - not sent, stays approved',
    );
    return null;
  }
}
