// Emits a Markdown coverage table from the json-summary reports produced by the
// root (services + packages) and per-app Vitest runs. Written to the GitHub
// Actions job summary. Safe to run locally too: `node .github/scripts/coverage-summary.mjs`.
import { readFileSync, existsSync } from 'node:fs';

const SOURCES = [
  { label: 'services + packages', path: 'coverage/coverage-summary.json' },
  { label: 'apps/agent-portal', path: 'apps/agent-portal/coverage/coverage-summary.json' },
  { label: 'apps/admin-portal', path: 'apps/admin-portal/coverage/coverage-summary.json' },
];

const pct = (m) => (m && typeof m.pct === 'number' ? `${m.pct.toFixed(1)}%` : '—');

const rows = [];
for (const { label, path } of SOURCES) {
  if (!existsSync(path)) continue;
  try {
    const total = JSON.parse(readFileSync(path, 'utf8')).total;
    rows.push(
      `| ${label} | ${pct(total.lines)} | ${pct(total.statements)} | ${pct(total.functions)} | ${pct(total.branches)} |`,
    );
  } catch {
    rows.push(`| ${label} | (unreadable report) | | | |`);
  }
}

if (rows.length === 0) {
  console.log('## Coverage\n\n_No coverage reports found._');
} else {
  console.log('## Coverage\n');
  console.log('| Area | Lines | Statements | Functions | Branches |');
  console.log('| --- | --- | --- | --- | --- |');
  console.log(rows.join('\n'));
}
