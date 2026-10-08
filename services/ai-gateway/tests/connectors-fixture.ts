import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  YijiConnector,
  createEnvConnectorRegistry,
  vendorsFromRows,
  type VendorRow,
  type YijiClient,
} from '@yiji/shared-types';

/**
 * The PRODUCTION registry shape (vendors table + env fallback), with the
 * connector delegating to the given fake client.
 */
export function dbConnectorsFor(
  client: unknown,
  rows: VendorRow[],
  onDirectoryFallback?: (err: unknown) => void,
): ConnectorRegistry {
  return createEnvConnectorRegistry({
    yiji: { client: {} },
    loadVendors: async () => vendorsFromRows(rows),
    ...(onDirectoryFallback ? { onDirectoryFallback } : {}),
    factories: {
      yiji: (vendor, settings) =>
        new YijiConnector(vendor, settings, { client: client as YijiClient }),
    },
  });
}

/**
 * A registry with ONE active Yiji vendor (`v1`, the id these tests send) whose
 * connector delegates to the given fake client — the shape the commerce routes
 * took as `yiji` before MV-2.
 */
export function connectorsFor(client: unknown, vendorId = 'v1'): ConnectorRegistry {
  return new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { platformVendorId: vendorId, platform: 'yiji', status: 'active' },
    ]),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', client: {} }),
    factories: {
      yiji: (vendor, settings) =>
        new YijiConnector(vendor, settings, { client: client as YijiClient }),
    },
  });
}
