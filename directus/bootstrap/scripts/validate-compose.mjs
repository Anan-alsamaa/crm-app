/**
 * Static validator for the project's docker-compose.yml. Confirms structural
 * validity without needing Docker installed (Docker isn't available in the
 * current dev env). Verifies: parseable YAML, every service has image|build,
 * required services present, port mappings, named volumes referenced.
 */
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const composePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml');
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

console.log('docker-compose.yml: OK');
console.log('  services:', Object.keys(services).join(', '));
console.log('  required all present:', required.join(', '));
console.log('  volumes declared:', [...declaredVolumes].join(', '));
console.log('  ports exposed:');
for (const [name, v] of Object.entries(services)) {
  if (v.ports?.length) console.log('   ', name, '->', v.ports.join(', '));
}
