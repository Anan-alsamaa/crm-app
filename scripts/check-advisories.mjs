#!/usr/bin/env node
/**
 * Answer "are we actually exposed?" from the lockfile, not from the alert count.
 *
 * GitHub's open-alert number is not a measure of exposure. An alert stays open
 * until Dependabot rescans, so a repo can be fully patched and still show
 * dozens. Reading the number instead of the lockfile leads to one of two bad
 * outcomes: a panicked bump of everything, or "it's all noise" — and the second
 * is how a real one gets missed.
 *
 * This compares every OPEN advisory against the versions actually locked, and
 * exits non-zero only if a locked version genuinely falls inside a vulnerable
 * range.
 *
 * Usage (needs `gh` authenticated):
 *   node scripts/check-advisories.mjs                 # infers the repo from git remote
 *   node scripts/check-advisories.mjs owner/repo
 *
 * Two traps this exists to avoid — both are easy to get wrong by hand:
 *
 *   1. LOWER BOUNDS. An advisory range is `>= 0.27.3, < 0.28.1`, not just
 *      "< 0.28.1". esbuild 0.25.12 is BELOW that range and therefore not
 *      affected, even though it looks older than the fixed version. Comparing
 *      only against `first_patched_version` reports healthy packages as
 *      vulnerable.
 *
 *   2. TYPES PACKAGES. `@types/nodemailer@6.4.23` is not `nodemailer@6.4.23`.
 *      A loose substring match pairs a types stub with a runtime advisory and
 *      invents an exposure that does not exist. Entries are matched anchored.
 *
 * A package with several live release branches (brace-expansion ships 1.x, 2.x
 * and 5.x at once) yields one advisory per branch; the lower-bound rule is what
 * keeps 1.1.18 from being judged against the 5.x fix.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function repoSlug() {
  if (process.argv[2]) return process.argv[2];
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  if (!m) throw new Error(`Could not infer owner/repo from origin: ${url}`);
  return m[1];
}

/** Numeric compare of x.y.z, ignoring any prerelease suffix. */
function cmp(a, b) {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  return 0;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every version of `pkg` that the lockfile resolves, anchored to entry starts. */
function lockedVersions(lock, pkg) {
  const re = new RegExp(`^\\s*'?${escapeRe(pkg)}@(\\d+\\.\\d+\\.\\d+)`, 'gm');
  return [...new Set([...lock.matchAll(re)].map((m) => m[1]))].sort(cmp);
}

/** Is `v` inside this advisory's vulnerable range? */
function isVulnerable(v, range, patched) {
  // Below the range's lower bound → a different release branch entirely.
  const lower = /(>=)\s*(\d+\.\d+\.\d+)/.exec(range || '');
  if (lower && cmp(v, lower[2]) < 0) return false;
  if (!patched || patched === 'NONE') return true; // no fix published yet
  return cmp(v, patched) < 0;
}

const slug = repoSlug();
const raw = execFileSync(
  'gh',
  [
    'api',
    `repos/${slug}/dependabot/alerts?state=open&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | [.dependency.package.name, (.dependency.manifest_path//"?"), ' +
      '(.security_vulnerability.vulnerable_version_range//""), ' +
      '(.security_vulnerability.first_patched_version.identifier//"NONE")] | @tsv',
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

const alerts = raw
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'));

// directus/local is a dev-only Directus instance pinned by upstream Directus;
// it has its own lockfile and its own decision. See docs/SECURITY-DEPENDENCIES.md.
const ours = alerts.filter((a) => !a[1].includes('directus/local'));
const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');

const packages = [...new Set(ours.map((a) => a[0]))].sort();
const exposed = [];

for (const pkg of packages) {
  const versions = lockedVersions(lock, pkg);
  const ranges = ours.filter((a) => a[0] === pkg);
  const bad = versions.filter((v) =>
    ranges.some(([, , range, patched]) => isVulnerable(v, range, patched)),
  );
  if (bad.length) exposed.push({ pkg, bad, need: ranges.map((r) => r[3]).join(' / ') });
  console.log(
    `  ${pkg.padEnd(34)}${versions.join(', ') || '<not locked>'}` +
      (bad.length
        ? `   EXPOSED: ${bad.join(', ')} (need ${ranges.map((r) => r[3]).join(' / ')})`
        : '   ok'),
  );
}

console.log(
  `\n${ours.length} open alert(s) on our manifests, across ${packages.length} package(s).`,
);
if (exposed.length === 0) {
  console.log('CLEAN — every locked version sits outside its advisory range.');
  console.log('Open alerts are awaiting a Dependabot rescan; they close on their own.');
  process.exit(0);
}
console.log(`EXPOSED — ${exposed.length} package(s) need action:`);
for (const e of exposed) console.log(`  ${e.pkg}: ${e.bad.join(', ')} -> need ${e.need}`);
process.exit(1);
