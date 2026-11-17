/**
 * PRODUCTION GUARD FOR THE YIJI V2 TENANT — the PURE half.
 *
 * Owner, 17 Nov 2026: Yiji v2 is approved for STAGING only and "must NOT reach
 * production in any way". Two independent checks enforce that; the decisions
 * live here with no I/O so they are unit-tested
 * (packages/shared-types/tests/prod-tenant-guard.test.ts — which deliberately
 * never spells the tenant's token, so it cannot trip the tree check itself):
 *
 *   1. TREE  — .github/workflows/deploy-ecs.yml, plan job, production only:
 *      the tagged tree must not contain the v2 connector or any file under
 *      services/ or packages/ that mentions the token. Fails BEFORE any image
 *      is promoted or any task definition registered.
 *   2. ECS   — scripts/release-check/yiji2-prod-guard.mjs ecs (release checks,
 *      prod only) and the deploy job's pre-register step: no production task
 *      definition may carry a VENDOR_YIJI2_* / YIJI2_* variable or secret.
 *
 * The ONLY override is ALLOW_YIJI2_ON_PROD=true (a repository variable,
 * vars.ALLOW_YIJI2_ON_PROD, passed through by the workflow). It is not set
 * today; setting it is the owner's decision, not an engineering one.
 */

/** The token searched for, case-insensitively (catches YIJI2_ env names too). */
export const V2_TOKEN = 'yiji2';

/** The v2 connector — its presence alone fails the tree check. */
export const V2_CONNECTOR_PATH = 'packages/shared-types/src/yiji2-connector.ts';

/** Directories whose files ship in production images or bundles. */
export const V2_GUARDED_DIRS = ['services', 'packages'];

/** Task-definition variable/secret prefixes that mean "v2 is configured". */
export const V2_ENV_PREFIXES = ['VENDOR_YIJI2_', 'YIJI2_'];

/** The override. Exactly the string 'true' (trimmed); anything else is "no". */
export function allowV2OnProd(value) {
  return String(value ?? '').trim() === 'true';
}

/**
 * Tree verdict for a production release.
 * @param {string[]} files  paths (repo-relative) `git grep -il` matched, plus
 *                          the connector path when it exists.
 * @param {{ allow?: boolean }} [opts]
 * @returns {{ status: 'PASS'|'FAIL'|'WARN', offenders: string[], detail: string }}
 */
export function v2TreeVerdict(files, { allow = false } = {}) {
  const offenders = [
    ...new Set(
      (files ?? [])
        .map((f) => String(f).trim().replace(/\\/g, '/'))
        .filter(Boolean)
        .filter(
          (f) => f === V2_CONNECTOR_PATH || V2_GUARDED_DIRS.some((d) => f.startsWith(`${d}/`)),
        ),
    ),
  ].sort();
  if (offenders.length === 0)
    return { status: 'PASS', offenders, detail: 'no Yiji v2 code in the release tree' };
  if (allow)
    return {
      status: 'WARN',
      offenders,
      detail: `ALLOW_YIJI2_ON_PROD=true — releasing ${offenders.length} Yiji v2 file(s) to production by override`,
    };
  return {
    status: 'FAIL',
    offenders,
    detail: `${offenders.length} file(s) in the release tree reference Yiji v2`,
  };
}

/** Names on a task definition that mean v2 is configured: env vars AND secrets. */
export function v2EnvNamesIn(taskDefinition) {
  const names = [];
  for (const c of taskDefinition?.containerDefinitions ?? []) {
    for (const e of [...(c?.environment ?? []), ...(c?.secrets ?? [])]) {
      const n = String(e?.name ?? '');
      if (V2_ENV_PREFIXES.some((p) => n.toUpperCase().startsWith(p))) names.push(n);
    }
  }
  return [...new Set(names)].sort();
}

/**
 * ECS verdict for the production cluster.
 * @param {{ service: string, taskDefinition: object }[]} services
 * @param {{ allow?: boolean }} [opts]
 * @returns {{ status: 'PASS'|'FAIL'|'WARN', offenders: string[], detail: string }}
 *          offenders are `service: NAME` strings — names only, never values.
 */
export function v2TaskDefVerdict(services, { allow = false } = {}) {
  const offenders = [];
  for (const s of services ?? [])
    for (const n of v2EnvNamesIn(s?.taskDefinition)) offenders.push(`${s?.service}: ${n}`);
  if ((services ?? []).length === 0)
    return { status: 'FAIL', offenders, detail: 'no production task definitions were read' };
  if (offenders.length === 0)
    return {
      status: 'PASS',
      offenders,
      detail: `no VENDOR_YIJI2_*/YIJI2_* variable on ${services.length} production task definition(s)`,
    };
  if (allow)
    return {
      status: 'WARN',
      offenders,
      detail: `ALLOW_YIJI2_ON_PROD=true — Yiji v2 variables on production by override: ${offenders.join(', ')}`,
    };
  return {
    status: 'FAIL',
    offenders,
    detail: `Yiji v2 variables on production: ${offenders.join(', ')}`,
  };
}
