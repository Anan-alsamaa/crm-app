/**
 * WHICH IMAGES A PUSH TO MAIN ACTUALLY CHANGES (owner, 25 Nov 2026: cut
 * Actions minutes, "there should be no bugs, or edge cases").
 *
 * A staging deploy used to rebuild and roll out every service on every push.
 * This decides, from the files changed since the LAST SUCCESSFUL staging
 * deploy, which images can differ. It is deliberately FAIL-SAFE: deploying a
 * service that did not change costs a few minutes; leaving out one that did
 * would ship a stale image. So:
 *
 * - Each rule mirrors what the image really contains (its Dockerfile COPY
 *   lines; the portals build reads apps/ and packages/).
 * - Any path no rule claims, and every path that feeds every build (lockfile,
 *   root manifests, workflows, scripts, Dockerfile ignore rules...), means
 *   EVERYTHING - exactly what a push did before this change.
 * - No changed files at all (or no base to diff against) also means
 *   everything: an empty list is not proof that nothing changed.
 *
 * Pure and synchronous so the test can pin every rule.
 */

/** Every deployable unit, in the order the workflow builds them. */
export const ALL_IMAGES = ['directus', 'socket-gateway', 'ai-gateway', 'workers', 'bootstrap'];
/** The images that run as ECS services (bootstrap is a one-off task image). */
export const SERVICES = ['directus', 'socket-gateway', 'ai-gateway', 'workers'];

const NODE_SERVICES = ['socket-gateway', 'ai-gateway', 'workers'];

/** Paths that feed EVERY build or the pipeline itself: deploy everything. */
const EVERYTHING = [
  /^\.github\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^tsconfig\.base\.json$/,
  /^\.dockerignore$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^scripts\//,
  /^deploy\//,
];

/**
 * Paths no image or portal contains: changing them deploys nothing.
 * Kept short on purpose - anything not listed falls through to "everything".
 */
const NOTHING = [
  /^docs\//,
  /^documentation\//,
  /^specs\//,
  /^tests\//, // the root Playwright suite
  /^Daily review notes\//,
  /^logo\//,
  /^exports\//,
  /^tools\//,
  /^\.husky\//,
  /^\.vscode\//,
  /^[^/]+\.md$/, // README, CLAUDE.md, DESIGN.md... at the repo root only
  /^playwright[^/]*\.config\.ts$/,
  /^vitest\.config\.ts$/,
  // Unit tests: excluded from every image (.dockerignore) and never bundled.
  /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/,
];

/** A single path -> the set of units it affects, or 'ALL'. */
export function unitsFor(path) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return 'ALL';
  if (EVERYTHING.some((r) => r.test(p))) return 'ALL';
  if (NOTHING.some((r) => r.test(p))) return [];

  // services/<name>/** -> that service's image only.
  const svc = /^services\/([^/]+)\//.exec(p);
  if (svc) return NODE_SERVICES.includes(svc[1]) ? [svc[1]] : 'ALL';

  // Shared packages: every image that COPYs them, plus the portals.
  if (/^packages\/shared-types\//.test(p)) return [...NODE_SERVICES, 'bootstrap', 'portals'];
  if (/^packages\/shared-config\//.test(p)) return [...NODE_SERVICES, 'portals'];
  // The other packages are only bundled by the portals (no service image
  // COPYs them - a service importing one would not even start).
  if (/^packages\/(ui|reports|i18n|order-views)\//.test(p)) return ['portals'];
  if (/^packages\//.test(p)) return 'ALL'; // a package nobody classified yet

  if (/^apps\/(admin-portal|agent-portal|marketing-portal|chat-widget)\//.test(p)) {
    return ['portals'];
  }
  if (/^apps\//.test(p)) return 'ALL';

  // directus/Dockerfile COPYs extensions/ and snapshot/.
  if (/^directus\/(Dockerfile|extensions\/|snapshot\/)/.test(p)) return ['directus'];
  // directus/bootstrap/Dockerfile COPYs bootstrap/ and compensation-clone/.
  if (/^directus\/(bootstrap|compensation-clone)\//.test(p)) return ['bootstrap'];

  return 'ALL';
}

/**
 * The plan for one push.
 *
 * @param {string[] | null | undefined} changedFiles  null = could not diff
 * @returns {{ all: boolean, images: string[], services: string[], portals: boolean, reasons: string[] }}
 */
export function affectedUnits(changedFiles) {
  const everything = (why) => ({
    all: true,
    images: [...ALL_IMAGES],
    services: [...SERVICES],
    portals: true,
    reasons: [why],
  });
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return everything('no changed-file list to classify - deploying everything');
  }
  const units = new Set();
  for (const f of changedFiles) {
    const u = unitsFor(f);
    if (u === 'ALL') return everything(`${f} feeds every build (or is unclassified)`);
    for (const x of u) units.add(x);
  }
  const images = ALL_IMAGES.filter((i) => units.has(i));
  return {
    all: false,
    images,
    services: SERVICES.filter((s) => units.has(s)),
    portals: units.has('portals'),
    reasons: [
      `${changedFiles.length} changed file(s) -> ${[...units].sort().join(', ') || 'nothing to deploy'}`,
    ],
  };
}
