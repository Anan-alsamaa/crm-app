#!/usr/bin/env node
/**
 * CI guard: fail when a security helper EXISTS (is exported) but has NO runtime
 * call site in non-test source.
 *
 * Background: merge `ecd655c` left `sanitizeFilename` and `decodeUploadContent`
 * defined-and-unit-tested in `attachments.ts` but no longer CALLED by the
 * `attachment:upload` handler — a silent security/integrity regression that
 * typecheck, lint, and the (still-green) unit tests did not catch. This guard
 * makes that exact failure mode a hard CI error.
 *
 * A helper "has a runtime call site" iff `name(` appears in a non-test `.ts`
 * file somewhere OTHER than its own `function name(` definition. Calls that only
 * exist in tests do NOT count — a helper exercised only by tests but wired into
 * no real code path is precisely the regression we are guarding against.
 *
 * Add new guarded helpers to GUARDED below.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARDED = ['sanitizeFilename', 'decodeUploadContent'];

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'tests']);

function isTestFile(name) {
  return /\.(test|spec)\.tsx?$/.test(name) || name.endsWith('.e2e.ts');
}

/** Recursively collect non-test .ts/.tsx source files. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      collect(full, out);
    } else if (/\.tsx?$/.test(entry) && !isTestFile(basename(entry))) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(REPO_ROOT).map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

const failures = [];
for (const name of GUARDED) {
  const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
  const defRe = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const exportRe = new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\b)`,
  );

  let defined = false;
  let callSites = 0;
  for (const { text } of files) {
    if (exportRe.test(text)) defined = true;
    const calls = (text.match(callRe) || []).length;
    const defs = (text.match(defRe) || []).length; // the `function name(` declaration itself
    callSites += calls - defs;
  }

  if (!defined) {
    console.log(`• ${name}: not exported anywhere — skipped (nothing to guard).`);
    continue;
  }
  if (callSites <= 0) {
    failures.push(name);
    console.error(
      `✗ ${name}: EXPORTED but has NO runtime call site in non-test source. ` +
        `A defined-but-uncalled security helper is a regression — wire it into the handler.`,
    );
  } else {
    console.log(`✓ ${name}: ${callSites} runtime call site(s).`);
  }
}

if (failures.length > 0) {
  console.error(`\nSecurity call-site guard FAILED for: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSecurity call-site guard passed.');
