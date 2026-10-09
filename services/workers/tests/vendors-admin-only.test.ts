import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roles, VENDOR_PUBLIC_FIELDS } from '../../../directus/bootstrap/src/roles.js';

/**
 * MV-5 (EMA-74): only the Administrator (admin_access) manages vendors, and
 * the integration settings are not readable by people without it.
 */
const INTEGRATION_FIELDS = [
  'platform',
  'api_base_url',
  'admin_api_url',
  'tenant_id',
  'brand_id',
  'notify_settings',
  'webhook_path_key',
  'support_settings',
];

describe('vendors permissions in roles.ts', () => {
  it('no non-Administrator role can create, update or delete a vendor', () => {
    const writes: string[] = [];
    for (const role of roles) {
      if (!role.permissions) continue; // Administrator: admin_access
      for (const p of role.permissions) {
        if (p.collection === 'vendors' && p.action !== 'read')
          writes.push(`${role.name}:${p.action}`);
      }
    }
    expect(writes).toEqual([]);
  });

  it('only the Administrator has admin_access', () => {
    expect(roles.filter((r) => r.adminAccess).map((r) => r.name)).toEqual(['Administrator']);
  });

  it('every vendors read is field-restricted, never *', () => {
    for (const role of roles) {
      for (const p of role.permissions ?? []) {
        if (p.collection !== 'vendors') continue;
        expect(p.fields, role.name).toBeDefined();
        expect(p.fields).not.toContain('*');
      }
    }
  });

  it('app roles (Admin, Agent) read the display fields only', () => {
    for (const name of ['Admin', 'Agent']) {
      const role = roles.find((r) => r.name === name)!;
      const reads = role.permissions!.filter((p) => p.collection === 'vendors');
      expect(reads).toHaveLength(1);
      expect([...(reads[0]!.fields ?? [])].sort()).toEqual([...VENDOR_PUBLIC_FIELDS].sort());
      for (const f of INTEGRATION_FIELDS) expect(reads[0]!.fields).not.toContain(f);
    }
  });

  it('a service reads an integration field only when it uses it', () => {
    const fieldsOf = (name: string) =>
      roles.find((r) => r.name === name)!.permissions!.find((p) => p.collection === 'vendors')!
        .fields!;
    expect(fieldsOf('svc-socket-gateway')).toContain('webhook_path_key');
    /* MV-6: the connector registries in these two read `platform` — it picks
       the connector — and nothing else from the integration settings. */
    for (const svc of ['svc-workers', 'svc-ai-gateway']) {
      expect(fieldsOf(svc)).toContain('platform');
      for (const f of INTEGRATION_FIELDS.filter((x) => x !== 'platform'))
        expect(fieldsOf(svc)).not.toContain(f);
    }
  });
});

describe('vendors in the app-roles-sync extension', () => {
  const SYNC = readFileSync(
    resolve(import.meta.dirname, '../../../directus/extensions/app-roles-sync/index.js'),
    'utf8',
  );

  it('custom roles read vendors with the display fields only', () => {
    expect(SYNC).toMatch(/g\('vendors', 'read', \{\}, VENDOR_PUBLIC_FIELDS\)/);
    const m = SYNC.match(/const VENDOR_PUBLIC_FIELDS = (\[[^\]]*\])/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!.replace(/'/g, '"'))).toEqual(VENDOR_PUBLIC_FIELDS);
  });

  it('no grant anywhere in the extension writes vendors', () => {
    expect(SYNC).not.toMatch(/readOnly\('vendors'\)|crud\('vendors'\)/);
    expect(SYNC).not.toMatch(/g\('vendors', '(create|update|delete)'/);
    expect(SYNC.match(/'vendors'/g)).toHaveLength(1);
  });
});
