import { describe, expect, it } from 'vitest';
// The pure half of scripts/seed-yiji2-vendor.mjs (owner, 2026-11-16).
import {
  YIJI2_VENDOR,
  assertAllowedApi,
  planYiji2Seed,
  yiji2EnvNames,
} from '../../../scripts/lib/yiji2-vendor-seed-plan.mjs';
import {
  YIJI2_DEFAULT_VENDOR_ID,
  YIJI2_VENDOR_KEY,
  vendorOAuthEnvNames,
  vendorSecretEnvNames,
} from '../src/index.js';

const yiji = {
  id: 'uuid-yiji',
  name: 'Yiji',
  platform: 'yiji',
  yiji_vendor_id: '1',
  webhook_path_key: 'yiji',
  status: 'active',
};

describe('the v2 vendor row the script writes', () => {
  it('is INACTIVE, on the yiji2 platform, with the ids the connector and gateway expect', () => {
    expect(YIJI2_VENDOR.status).toBe('inactive');
    expect(YIJI2_VENDOR.platform).toBe('yiji2');
    expect(YIJI2_VENDOR.yiji_vendor_id).toBe(YIJI2_DEFAULT_VENDOR_ID);
    expect(YIJI2_VENDOR.webhook_path_key).toBe(YIJI2_VENDOR_KEY);
    expect(Object.keys(YIJI2_VENDOR)).not.toContain('client_secret');
  });

  it('creates the row once and plans nothing on a re-run, never touching v1', () => {
    const first = planYiji2Seed({ vendors: [yiji] });
    expect('actions' in first && first.actions).toEqual([
      expect.objectContaining({
        op: 'create',
        collection: 'vendors',
        data: expect.objectContaining({ status: 'inactive' }),
      }),
    ]);
    const again = planYiji2Seed({ vendors: [yiji, { id: 'uuid-v2', ...YIJI2_VENDOR }] });
    expect('actions' in again && again.actions.map((a) => a.op)).toEqual(['none']);
  });

  it("never switches an activated row back off and never resets the owner's host", () => {
    /* review 2026-11-16: a re-run after activation reset the real host to the
       placeholder, and the prod credentials would have gone there. */
    const active = {
      id: 'uuid-v2',
      ...YIJI2_VENDOR,
      status: 'active',
      name: 'Yiji V2 (prod)',
      api_base_url: 'https://api.yiji.app',
    };
    const plan = planYiji2Seed({ vendors: [yiji, active] });
    expect('actions' in plan && plan.actions.map((a) => a.op)).toEqual(['none']);
    /* identity drift IS corrected; status still untouched */
    const drifted = { ...active, webhook_path_key: 'yiji-two' };
    const fix = planYiji2Seed({ vendors: [yiji, drifted] });
    expect('actions' in fix && fix.actions[0]).toMatchObject({
      op: 'update',
      id: 'uuid-v2',
      data: { webhook_path_key: 'yiji2' },
    });
    expect('actions' in fix && fix.actions[0]?.data).not.toHaveProperty('status');
    expect('actions' in fix && fix.actions[0]?.data).not.toHaveProperty('api_base_url');
    /* an EMPTY host gets the placeholder, so the row is never left URL-less */
    const blank = { ...active, api_base_url: '' };
    const fill = planYiji2Seed({ vendors: [yiji, blank] });
    expect('actions' in fill && fill.actions[0]).toMatchObject({
      op: 'update',
      data: { api_base_url: YIJI2_VENDOR.api_base_url },
    });
  });

  it('refuses to adopt a vendor on another platform that already holds the id or the key', () => {
    expect(planYiji2Seed({ vendors: [{ ...yiji, yiji_vendor_id: '2' }] })).toMatchObject({
      refuse: expect.stringContaining('NOT on the yiji2 platform'),
    });
    expect(planYiji2Seed({ vendors: [{ ...yiji, webhook_path_key: 'yiji2' }] })).toMatchObject({
      refuse: expect.stringContaining('NOT on the yiji2 platform'),
    });
  });

  it('refuses production unless told, and accepts local and staging', () => {
    expect(() => assertAllowedApi('https://crm-api.anan.sa')).toThrow(/production/);
    expect(assertAllowedApi('https://crm-api.anan.sa', { allowProd: true })).toBe(
      'crm-api.anan.sa',
    );
    expect(assertAllowedApi('https://crm-api-staging.anan.sa')).toBe('crm-api-staging.anan.sa');
    expect(assertAllowedApi('http://localhost:8092')).toBe('localhost:8092');
    expect(() => assertAllowedApi('not a url')).toThrow();
  });

  it('names the env variables exactly as shared-types derives them', () => {
    const names = yiji2EnvNames('yiji2');
    expect(names['socket-gateway']).toEqual([
      vendorSecretEnvNames('yiji2').jwt,
      vendorSecretEnvNames('yiji2').webhook,
      'YIJI2_VENDOR_ID',
    ]);
    expect(names['ai-gateway']).toEqual([
      vendorOAuthEnvNames('yiji2').clientId,
      vendorOAuthEnvNames('yiji2').clientSecret,
    ]);
    expect(names.workers).toEqual(names['ai-gateway']);
  });
});
