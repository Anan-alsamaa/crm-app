/**
 * Fail the build when a translatable string ships without its Arabic.
 *
 *   node scripts/check-i18n-coverage.mjs
 *
 * Why this exists: `t('some.key', { defaultValue: 'Some text' })` renders the
 * English default when the key is missing from `ar.json`, silently and without
 * any error. So an Arabic-speaking user saw a page that was Arabic everywhere
 * except the parts most recently built — which reads as a broken feature rather
 * than a missing translation, and is exactly how it was reported: "the AI is
 * still in English". 196 keys had accumulated that way before anyone noticed.
 *
 * Nothing in the toolchain could catch it: the code compiles, the tests pass,
 * and the page renders. Only a reader of Arabic would ever know. This is that
 * reader.
 *
 * Keys carrying `ns: 'common'` are checked against packages/i18n instead of the
 * app's own file. Skipping them was the first version's blind spot: the coupon
 * workflow added approved / rejected / edited / assigned to a shared status
 * vocabulary that only knew open / pending / resolved / closed, so an Arabic
 * reader saw the raw English key sitting in the pill and nothing complained.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every .tsx under a directory. Hand-rolled: fs.globSync needs Node 22. */
function tsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const APPS = ['agent-portal', 'admin-portal'];
const COMMON_AR = 'packages/i18n/src/locales/ar/common.json';

/**
 * `t('key', { ...options })` — the options object is matched loosely enough to
 * survive nested `{{interpolation}}`, which a naive brace match trips over.
 */
const CALL = /\bt\(\s*(['"])([\w.]+)\1\s*(?:,\s*\{((?:[^{}]|\{\{[^}]*\}\})*)\})?/gs;
const DEFAULT_VALUE = /defaultValue:\s*(['"])(.*?)\1/s;

function lookup(tree, dotted) {
  let cur = tree;
  for (const part of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

let failures = 0;

for (const app of APPS) {
  const root = join('apps', app);
  const ar = JSON.parse(readFileSync(join(root, 'src/i18n/ar.json'), 'utf8'));
  const common = JSON.parse(readFileSync(COMMON_AR, 'utf8'));
  const missing = new Map();

  for (const file of tsxFiles(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const [, , key, options = ''] = m;
      // Only keys that carry an English default are translatable strings; a
      // bare `t('status.pending')` is a lookup into data, not a new string.
      const dv = DEFAULT_VALUE.exec(options);
      if (!dv) continue;
      // A `ns: 'common'` key lives in packages/i18n, not in the app's file.
      const isCommon = /ns:\s*(['"])common\1/.test(options);
      if (lookup(isCommon ? common : ar, key) !== undefined) continue;
      if (!missing.has(key)) {
        missing.set(key, { text: dv[2], file, where: isCommon ? 'packages/i18n' : app });
      }
    }
  }

  if (missing.size === 0) {
    console.log(`  ${app}: every translatable key has Arabic`);
    continue;
  }
  failures += missing.size;
  console.error(`\n  ${app}: ${missing.size} key(s) with no Arabic — they render English:`);
  for (const [key, { text, file, where }] of [...missing].sort()) {
    console.error(`    ${key}  → add to ${where}\n      "${text}"\n      ${file}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} untranslated key(s). Add each one where the line above says:\n` +
      '  an app  -> apps/<app>/src/i18n/ar.json\n' +
      '  common  -> packages/i18n/src/locales/ar/common.json\n' +
      'Every one of these shows an Arabic-speaking user an English control.',
  );
  process.exit(1);
}
