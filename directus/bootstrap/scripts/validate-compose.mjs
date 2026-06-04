/**
 * Static validator for the project's compose files. Confirms structural
 * validity without needing Docker installed (Docker isn't available in the
 * current dev env). Verifies: parseable YAML, every service has image|build,
 * required services present, port mappings, named volumes referenced.
 *
 * Usage:
 *   node scripts/validate-compose.mjs                      # docker-compose.yml
 *   node scripts/validate-compose.mjs docker-compose.prod.yml
 */
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const file = process.argv[2] ?? 'docker-compose.yml';
const composePath = resolve(repoRoot, file);
// Prod compose uses `${VAR:?message}` which is valid YAML but the `:` inside
// can confuse a naive reader — js-yaml treats the whole thing as a string, fine.
const doc = yaml.load(readFileSync(composePath, 'utf8'));
const services = doc.services ?? {};
const required = ['postgres', 'redis', 'directus', 'socket-gateway', 'workers', 'ai-gateway'];

const missing = required.filter((s) => !services[s]);
if (missing.length) {
  console.error('MISSING SERVICES:', missing.join(', '));
  process.exit(1);
}
const noSource = Object.entries(services).filter(([, v]) => !v.image && !v.build);
if (noSource.length) {
  console.error('SERVICES WITHOUT image|build:', noSource.map(([k]) => k).join(', '));
  process.exit(1);
}
const declaredVolumes = new Set(Object.keys(doc.volumes ?? {}));
const usedVolumes = new Set();
for (const v of Object.values(services)) {
  for (const m of v.volumes ?? []) {
    const name = typeof m === 'string' ? m.split(':')[0] : m.source;
    if (name && !name.startsWith('.') && !name.startsWith('/')) usedVolumes.add(name);
  }
}
const unboundVolumes = [...usedVolumes].filter((n) => !declaredVolumes.has(n));
if (unboundVolumes.length) {
  console.error('VOLUMES USED BUT NOT DECLARED:', unboundVolumes.join(', '));
  process.exit(1);
}

// Production-specific assertions: the Node services must run with
// NODE_ENV=production and must NOT carry a wildcard CORS default.
if (/prod/.test(file)) {
  const nodeServices = ['socket-gateway', 'workers', 'ai-gateway'];
  for (const name of nodeServices) {
    const env = services[name]?.environment ?? {};
    if (env.NODE_ENV !== 'production') {
      console.error(`PROD: ${name} must set NODE_ENV=production`);
      process.exit(1);
    }
  }
  const corsRefs = nodeServices
    .map((n) => services[n]?.environment?.CORS_ORIGIN)
    .filter((v) => v !== undefined);
  const wildcard = corsRefs.find((v) => String(v).includes("'*'") || String(v).trim() === '*');
  if (wildcard) {
    console.error('PROD: CORS_ORIGIN must not default to "*"');
    process.exit(1);
  }
}

console.log(`${file}: OK`);
console.log('  services:', Object.keys(services).join(', '));
console.log('  required all present:', required.join(', '));
console.log('  volumes declared:', [...declaredVolumes].join(', '));
console.log('  ports exposed:');
for (const [name, v] of Object.entries(services)) {
  if (v.ports?.length) console.log('   ', name, '->', v.ports.join(', '));
}
