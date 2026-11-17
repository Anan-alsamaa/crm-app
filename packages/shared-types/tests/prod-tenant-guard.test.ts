import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The pure production guard behind the release-check CLI (scripts/release-check/)
// and the "Guard: Yiji v2 must not reach production" workflow step.
//
// THIS FILE NEVER SPELLS THE TENANT'S TOKEN. It lives under packages/, which
// the tree guard scans; every token-bearing string is built from the lib's
// own constants, and the last test proves this file stays clean.
import {
  V2_CONNECTOR_PATH as CONNECTOR,
  V2_ENV_PREFIXES as PREFIXES,
  V2_TOKEN as TOKEN,
  allowV2OnProd as allowOverride,
  v2EnvNamesIn as envNamesIn,
  v2TaskDefVerdict as taskDefVerdict,
  v2TreeVerdict as treeVerdict,
} from '../../../scripts/release-check/lib/prod-tenant-guard.mjs';

const [VENDOR_PREFIX, BARE_PREFIX] = PREFIXES as [string, string];
const td = (env: { name: string; value?: string }[], secrets: { name: string }[] = []) => ({
  family: 'crm-prod-workers',
  containerDefinitions: [{ name: 'app', environment: env, secrets }],
});

describe('override', () => {
  it('only the exact string "true" allows production', () => {
    expect(allowOverride('true')).toBe(true);
    expect(allowOverride(' true ')).toBe(true);
    for (const v of [undefined, null, '', 'false', 'TRUE', '1', 'yes'])
      expect(allowOverride(v)).toBe(false);
  });
});

describe('tree verdict', () => {
  it('passes a tree without the v2 tenant', () => {
    expect(treeVerdict([]).status).toBe('PASS');
  });

  it('fails on the connector and lists every offending file once, sorted', () => {
    const v = treeVerdict([
      `services/socket-gateway/src/webhooks-${TOKEN}.ts`,
      CONNECTOR,
      CONNECTOR,
      'packages/shared-types/src/index.ts',
    ]);
    expect(v.status).toBe('FAIL');
    expect(v.offenders).toEqual([
      'packages/shared-types/src/index.ts',
      CONNECTOR,
      `services/socket-gateway/src/webhooks-${TOKEN}.ts`,
    ]);
    expect(v.detail).toMatch(/3 file\(s\)/);
  });

  it('ignores matches outside services/ and packages/ (docs, scripts, the guard itself)', () => {
    expect(treeVerdict(['docs/YIJI-V2-TENANT.md', 'scripts/release-check/lib/x.mjs']).status).toBe(
      'PASS',
    );
  });

  it('normalises Windows separators', () => {
    expect(treeVerdict([CONNECTOR.replace(/\//g, '\\')]).offenders).toEqual([CONNECTOR]);
  });

  it('the override turns FAIL into WARN, still listing the files', () => {
    const v = treeVerdict([CONNECTOR], { allow: true });
    expect(v.status).toBe('WARN');
    expect(v.offenders).toEqual([CONNECTOR]);
  });
});

describe('task-definition verdict', () => {
  it('passes production task definitions without v2 variables (v1 is untouched)', () => {
    const v = taskDefVerdict([
      { service: 'workers', taskDefinition: td([{ name: 'YIJI_ADMIN_API_URL', value: 'x' }]) },
      { service: 'directus', taskDefinition: td([{ name: 'VENDOR_YIJI_WEBHOOK_SECRET' }]) },
    ]);
    expect(v.status).toBe('PASS');
  });

  it('fails on a vendor-prefixed env var, a bare-prefixed secret, any container', () => {
    const multi = {
      containerDefinitions: [
        { environment: [{ name: 'NODE_ENV', value: 'production' }] },
        { environment: [{ name: `${BARE_PREFIX}API_URL`, value: 'secret-value' }] },
      ],
    };
    const v = taskDefVerdict([
      { service: 'workers', taskDefinition: td([], [{ name: `${VENDOR_PREFIX}WEBHOOK_SECRET` }]) },
      { service: 'ai-gateway', taskDefinition: multi },
    ]);
    expect(v.status).toBe('FAIL');
    expect(v.offenders).toEqual([
      `workers: ${VENDOR_PREFIX}WEBHOOK_SECRET`,
      `ai-gateway: ${BARE_PREFIX}API_URL`,
    ]);
    expect(v.detail).not.toContain('secret-value'); // names only, never values
  });

  it('matches the prefix case-insensitively but never a mere substring', () => {
    expect(envNamesIn(td([{ name: `${VENDOR_PREFIX.toLowerCase()}KEY` }]))).toHaveLength(1);
    expect(envNamesIn(td([{ name: `X_${BARE_PREFIX}KEY` }]))).toEqual([]);
  });

  it('reading nothing is a FAIL, not a pass', () => {
    expect(taskDefVerdict([]).status).toBe('FAIL');
  });

  it('the override turns FAIL into WARN', () => {
    const v = taskDefVerdict(
      [{ service: 'workers', taskDefinition: td([{ name: `${BARE_PREFIX}X` }]) }],
      {
        allow: true,
      },
    );
    expect(v.status).toBe('WARN');
  });
});

describe('this test cannot trip the guard it tests', () => {
  it('never spells the token', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src.toLowerCase().includes(TOKEN)).toBe(false);
  });
});
