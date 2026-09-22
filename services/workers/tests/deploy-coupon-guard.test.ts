import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The CI guard that decides whether STAGING may deliver coupons.
 *
 * WHY THIS IS TESTED AT ALL. It is shell inside a YAML file, which nothing
 * type-checks and no test touched until now — and it is the last thing
 * standing between a misconfigured staging deploy and a real stranger's Yiji
 * account. Staging shares Yiji's PRODUCTION coupon API, and a delivered
 * coupon cannot be revoked from our side.
 *
 * It was ALSO too strict until 2026-09-22 (it forbade delivery outright) and
 * a later edit relaxed it. An edit that relaxes it too far is exactly the
 * change nobody would notice, so the four shapes below are pinned.
 *
 * The guard's own script is READ OUT OF THE WORKFLOW rather than copied here.
 * A copy would drift, and a test that passes against a stale copy of the rule
 * is worse than no test.
 */

const WORKFLOW = '.github/workflows/deploy-ecs.yml';

/**
 * Pull the guard's NODE script straight out of the workflow.
 *
 * EXTRACTED, never copied. A copy drifts, and a test that passes against a
 * stale copy of the rule is worse than no test at all.
 */
function guardScript(): string {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const start = yaml.indexOf('Guard — staging may deliver ONLY to a redirect handset');
  expect(start, 'the coupon guard is missing from the workflow').toBeGreaterThan(-1);
  const after = yaml.slice(start);
  const open = after.indexOf("node -e '");
  expect(open, 'the guard is no longer a node -e script').toBeGreaterThan(-1);
  const close = after.indexOf("\n          '", open);
  expect(close, 'could not find the end of the guard script').toBeGreaterThan(open);
  return after
    .slice(open + "node -e '".length, close)
    .split('\n')
    .map((l) => l.replace(/^ {12}/, ''))
    .join('\n');
}

/** A Windows path inside the script breaks its own escapes; use forward slashes. */
const posix = (p: string): string => p.split('\\').join('/');

/** Run the real guard against a task definition, return true when it ALLOWS. */
function allows(env: Record<string, string>): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const taskdef = join(dir, 'taskdef.json');
  writeFileSync(
    taskdef,
    JSON.stringify(
      {
        containerDefinitions: [
          { environment: Object.entries(env).map(([name, value]) => ({ name, value })) },
        ],
      },
      null,
      2,
    ),
  );
  const script = guardScript().replaceAll('/tmp/taskdef.json', posix(taskdef));
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('CI guard: staging coupon delivery', () => {
  it('allows delivery OFF', () => {
    expect(allows({ YIJI_COUPON_DELIVERY: 'off' })).toBe(true);
  });

  it('allows delivery ON when both redirects are set', () => {
    expect(
      allows({
        YIJI_COUPON_DELIVERY: 'on',
        COUPON_REDIRECT_PHONE: '0537301009',
        PUSH_REDIRECT_PHONE: '0565266122',
      }),
    ).toBe(true);
  });

  /* The dangerous shape: staging would send to REAL customers. */
  it('REFUSES delivery ON with no redirects', () => {
    expect(allows({ YIJI_COUPON_DELIVERY: 'on' })).toBe(false);
  });

  /* The subtle one — a presence check would pass this and ship it. */
  it('REFUSES delivery ON when a redirect is present but EMPTY', () => {
    expect(
      allows({
        YIJI_COUPON_DELIVERY: 'on',
        COUPON_REDIRECT_PHONE: '',
        PUSH_REDIRECT_PHONE: '0565266122',
      }),
    ).toBe(false);
  });

  it('REFUSES delivery ON when only ONE redirect is set', () => {
    expect(allows({ YIJI_COUPON_DELIVERY: 'on', COUPON_REDIRECT_PHONE: '0537301009' })).toBe(false);
  });

  it('REFUSES a task definition with no coupon flag at all', () => {
    expect(allows({ SOMETHING_ELSE: 'x' })).toBe(false);
  });
});
