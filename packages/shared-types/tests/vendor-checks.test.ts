import { describe, expect, it } from 'vitest';
// The pure per-vendor release checks behind scripts/release-check/regressions.mjs (MV-6).
import {
  KNOWN_PLATFORMS,
  MOCK_PROBE_ORDER_ID,
  classifyChatLoginProbe,
  classifyMockOrderProbe,
  classifyResolveProbe,
  classifyWebhookProbe,
  connectorVerdict,
  filterLeaks,
  isolationPairs,
  isolationVerdict,
  platformOf,
  signWebhook,
  vendorIdOfRow,
  vendorSecretEnvNames as checkNames,
} from '../../../scripts/release-check/lib/vendor-checks.mjs';
import { COMMERCE_PLATFORMS, MockConnector, vendorSecretEnvNames } from '../src/index.js';
import { signWebhook as gatewaySign } from '../../../services/socket-gateway/src/webhook.js';

const yiji = { id: 'uuid-yiji', name: 'Yiji', yiji_vendor_id: '1', platform: 'yiji' };
const test = { id: 'uuid-test', name: 'Test Vendor', yiji_vendor_id: 'test-1', platform: 'mock' };

describe('mirrors of shared-types / gateway stay in step', () => {
  it('platforms, secret names and webhook signing match', () => {
    expect(KNOWN_PLATFORMS).toEqual([...COMMERCE_PLATFORMS]);
    for (const k of ['yiji', 'test', 'acme-foods'])
      expect(checkNames(k)).toEqual(vendorSecretEnvNames(k));
    expect(signWebhook('s', '1', '{}')).toBe(gatewaySign('s', '1', '{}'));
  });
});

describe('connectorVerdict (static, from the row)', () => {
  it('passes yiji, NULL platform (=yiji) and mock on staging', () => {
    expect(connectorVerdict(yiji, { env: 'prod' }).status).toBe('PASS');
    expect(connectorVerdict({ ...yiji, platform: null }, { env: 'prod' }).detail).toBe(
      'platform yiji',
    );
    expect(connectorVerdict(test, { env: 'staging' }).status).toBe('PASS');
  });
  it('fails an unknown platform, a missing platform id, and a mock vendor on prod', () => {
    expect(connectorVerdict({ ...yiji, platform: 'shopify' }, { env: 'staging' }).status).toBe(
      'FAIL',
    );
    expect(connectorVerdict({ ...yiji, yiji_vendor_id: ' ' }, { env: 'staging' }).status).toBe(
      'FAIL',
    );
    expect(connectorVerdict(test, { env: 'prod' }).detail).toMatch(/PRODUCTION/);
  });
});

describe('classifyResolveProbe (live, the AI gateway)', () => {
  const unknown = { error: 'unknown_vendor' };
  it('unknown_vendor fails a real vendor but SKIPS a mock one (flag not set)', () => {
    expect(classifyResolveProbe(yiji, 404, unknown).status).toBe('FAIL');
    const s = classifyResolveProbe(test, 404, unknown);
    expect(s.status).toBe('SKIP');
    expect(s.detail).toMatch(/ALLOW_MOCK_VENDORS/);
  });
  it('any other answer means the connector resolved', () => {
    expect(classifyResolveProbe(yiji, 200, { data: null }).status).toBe('PASS');
    expect(classifyResolveProbe(yiji, 504, { error: 'commerce_unavailable' }).status).toBe('PASS');
    expect(classifyResolveProbe(yiji, 500, {}).status).toBe('FAIL');
    expect(classifyResolveProbe(yiji, 401, {}).status).toBe('FAIL');
  });
});

describe('classifyMockOrderProbe (the mock vendor never reaches Yiji)', () => {
  it('passes the MockConnector’s own order', async () => {
    const order = await new MockConnector(
      { platformVendorId: 'test-1', platform: 'mock', status: 'active', name: 'Test Vendor' },
      { platform: 'mock' },
    ).getOrder(MOCK_PROBE_ORDER_ID);
    expect(classifyMockOrderProbe(200, { data: order })).toMatchObject({ status: 'PASS' });
  });
  it('fails anything that is not mock data, skips without the flag', () => {
    expect(
      classifyMockOrderProbe(200, { data: { orderId: '74014', restaurantName: 'Real', items: [] } })
        .status,
    ).toBe('FAIL');
    expect(classifyMockOrderProbe(200, { data: null }).status).toBe('FAIL');
    expect(classifyMockOrderProbe(504, { error: 'commerce_unavailable' }).status).toBe('FAIL');
    expect(classifyMockOrderProbe(404, { error: 'unknown_vendor' }).status).toBe('SKIP');
  });
});

describe('isolation', () => {
  it('pairs every vendor with every other, both directions', () => {
    expect(
      isolationPairs([yiji, test, { name: 'no id' }]).map(([a, b]) => `${a.id}>${b.id}`),
    ).toEqual(['uuid-yiji>uuid-test', 'uuid-test>uuid-yiji']);
    expect(isolationPairs([yiji])).toEqual([]);
  });
  it('reads bare and expanded vendor ids', () => {
    expect(vendorIdOfRow({ vendor: 'v' })).toBe('v');
    expect(vendorIdOfRow({ vendor: { id: 'v' } })).toBe('v');
    expect(vendorIdOfRow({ vendor: null })).toBeNull();
    expect(
      filterLeaks([{ vendor: 'b' }, { vendor: { id: 'a' } }, { vendor: null }], 'b'),
    ).toHaveLength(2);
  });
  it('fails when A’s rows come back under B, or B’s filter returns foreign rows', () => {
    const base = { collection: 'contacts', a: yiji, b: test, sampled: 3 };
    expect(
      isolationVerdict({ ...base, crossRows: [], bRows: [{ vendor: 'uuid-test' }] }).status,
    ).toBe('PASS');
    expect(isolationVerdict({ ...base, crossRows: [{ id: 1 }], bRows: [] }).status).toBe('FAIL');
    expect(
      isolationVerdict({ ...base, crossRows: [], bRows: [{ vendor: 'uuid-yiji' }] }).status,
    ).toBe('FAIL');
  });
});

describe('test vendor chat login / webhook: SKIP until the secrets exist', () => {
  it('chat login', () => {
    expect(classifyChatLoginProbe('test', 200, { ok: true, token: 't' }).status).toBe('PASS');
    const s = classifyChatLoginProbe('test', 503, { ok: false });
    expect(s).toMatchObject({ status: 'SKIP' });
    expect(s.detail).toMatch(/VENDOR_TEST_JWT_SECRET/);
    expect(classifyChatLoginProbe('test', 404, {}).status).toBe('FAIL');
    expect(classifyChatLoginProbe('test', 429, {}).status).toBe('SKIP');
  });
  it('webhook', () => {
    expect(classifyWebhookProbe('test', 503, { signed: false }).detail).toMatch(
      /VENDOR_TEST_WEBHOOK_SECRET/,
    );
    expect(classifyWebhookProbe('test', 401, { signed: false }).status).toBe('PASS');
    expect(classifyWebhookProbe('test', 202, { signed: false }).status).toBe('FAIL');
    expect(classifyWebhookProbe('test', 202, { signed: true }).status).toBe('PASS');
    expect(classifyWebhookProbe('test', 401, { signed: true }).status).toBe('FAIL');
    expect(classifyWebhookProbe('test', 404, { signed: false }).status).toBe('FAIL');
  });
  it('platformOf treats blank as yiji', () => {
    expect(platformOf({})).toBe('yiji');
    expect(platformOf({ platform: ' mock ' })).toBe('mock');
  });
});
