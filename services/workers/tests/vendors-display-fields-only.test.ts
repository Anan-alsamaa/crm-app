import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * EVERY NON-OWNER READ OF `vendors` USES DISPLAY FIELDS ONLY (MV-5, 2026-10-08).
 *
 * Since MV-5 a non-Administrator may read only these fields of `vendors`, and
 * Directus refuses the WHOLE query if it names one more. The late-orders report
 * borrowed the owner-only Vendors page's full read (integration fields +
 * support_settings) and would have been refused for WeCare Admin. This scans
 * both portals so the next such read fails here instead of in production.
 */
const DISPLAY = new Set(['id', 'name', 'logo', 'colors', 'status', 'yiji_vendor_id']);
const ROOT = join(__dirname, '..', '..', '..');
const OWNER_ONLY = /features[\\/]vendors[\\/]/; // the owner-only Vendors page and its api

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('vendors reads outside the owner-only page', () => {
  const sources = ['apps/agent-portal/src', 'apps/admin-portal/src'].flatMap((d) =>
    files(join(ROOT, d)),
  );

  it('name only display fields', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const src = readFileSync(f, 'utf8');
      const re = /readItems\(\s*'vendors'[^)]*?fields:\s*\[([^\]]*)\]/gs;
      for (const m of src.matchAll(re)) {
        const fields = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
        const extra = fields.filter((x) => !DISPLAY.has(x));
        const inOwnerPage = OWNER_ONLY.test(relative(ROOT, f));
        // Inside the owner page only the display-only directory hook is held to the rule.
        const isDirectoryHook =
          inOwnerPage && /useVendorDirectory[\s\S]{0,200}$/.test(src.slice(0, m.index));
        if ((!inOwnerPage || isDirectoryHook) && (extra.length || m[1]!.includes('...'))) {
          offenders.push(`${relative(ROOT, f)}: ${extra.join(', ') || 'spread fields'}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the late-orders report uses the display-only directory', () => {
    const page = readFileSync(
      join(ROOT, 'apps/admin-portal/src/features/late-orders/LateOrdersReportPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/useVendorDirectory\(\)/);
    expect(page).not.toMatch(/useVendors\(\)/);
  });
});
