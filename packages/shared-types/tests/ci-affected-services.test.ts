import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The staging deploy's "what changed" classifier (scripts/ci/). Kept beside
// the other pipeline guards' tests (prod-tenant-guard.test.ts) because the
// root vitest only collects packages/ and services/.
import {
  ALL_IMAGES,
  SERVICES,
  affectedUnits,
  unitsFor,
} from '../../../scripts/ci/lib/affected-services.mjs';

const EVERYTHING = {
  all: true,
  images: ALL_IMAGES,
  services: SERVICES,
  portals: true,
};

describe('affected services: fail-safe defaults', () => {
  it('no list, or an empty list, deploys EVERYTHING', () => {
    expect(affectedUnits(null)).toMatchObject(EVERYTHING);
    expect(affectedUnits(undefined)).toMatchObject(EVERYTHING);
    expect(affectedUnits([])).toMatchObject(EVERYTHING);
  });

  it.each([
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    '.dockerignore',
    '.github/workflows/deploy-ecs.yml',
    '.github/workflows/ci.yml',
    'scripts/build-widget.sh',
    'scripts/release-check/regressions.mjs',
    'deploy/aws/ecs/workers.json',
  ])('%s feeds every build: EVERYTHING', (f) => {
    expect(affectedUnits([f])).toMatchObject(EVERYTHING);
  });

  it.each([
    'some-new-dir/file.ts',
    'services/new-service/src/index.ts',
    'packages/new-package/src/index.ts',
    'apps/new-app/src/main.tsx',
    'directus/local/docker-compose.yml',
    'undefined',
  ])('unclassified %s: EVERYTHING', (f) => {
    expect(affectedUnits([f])).toMatchObject(EVERYTHING);
  });

  it('one everything-file among narrow ones still deploys EVERYTHING', () => {
    expect(affectedUnits(['services/workers/src/routing.ts', 'pnpm-lock.yaml'])).toMatchObject(
      EVERYTHING,
    );
  });
});

describe('affected services: narrow changes', () => {
  it('only workers changed: build and deploy workers only, no portals', () => {
    expect(affectedUnits(['services/workers/src/routing.ts'])).toEqual(
      expect.objectContaining({
        all: false,
        images: ['workers'],
        services: ['workers'],
        portals: false,
      }),
    );
  });

  it('the workers Dockerfile is the workers image', () => {
    expect(affectedUnits(['services/workers/Dockerfile']).images).toEqual(['workers']);
  });

  it('socket-gateway and ai-gateway each map to themselves', () => {
    const r = affectedUnits([
      'services/socket-gateway/src/connection.ts',
      'services/ai-gateway/src/server.ts',
    ]);
    expect(r.images).toEqual(['socket-gateway', 'ai-gateway']);
    expect(r.services).toEqual(['socket-gateway', 'ai-gateway']);
    expect(r.portals).toBe(false);
  });

  it('shared-types changed: every image that COPYs it, the bootstrap, and the portals', () => {
    const r = affectedUnits(['packages/shared-types/src/queues.ts']);
    expect(r.images).toEqual(['socket-gateway', 'ai-gateway', 'workers', 'bootstrap']);
    expect(r.services).toEqual(['socket-gateway', 'ai-gateway', 'workers']);
    expect(r.portals).toBe(true);
  });

  it('shared-config changed: the three Node services and the portals', () => {
    const r = affectedUnits(['packages/shared-config/src/index.ts']);
    expect(r.images).toEqual(['socket-gateway', 'ai-gateway', 'workers']);
    expect(r.portals).toBe(true);
  });

  it('a directus extension changed: directus only', () => {
    const r = affectedUnits(['directus/extensions/app-roles-sync/index.js']);
    expect(r.images).toEqual(['directus']);
    expect(r.services).toEqual(['directus']);
    expect(r.portals).toBe(false);
  });

  it('the directus snapshot and Dockerfile are the directus image', () => {
    expect(affectedUnits(['directus/snapshot/snapshot.yaml']).images).toEqual(['directus']);
    expect(affectedUnits(['directus/Dockerfile']).images).toEqual(['directus']);
  });

  it('directus bootstrap / compensation-clone: the bootstrap image only (no ECS service)', () => {
    const r = affectedUnits([
      'directus/bootstrap/src/apply.ts',
      'directus/compensation-clone/x.mjs',
    ]);
    expect(r.images).toEqual(['bootstrap']);
    expect(r.services).toEqual([]);
    expect(r.portals).toBe(false);
  });

  it('a portal-only change: portals only, no image, no service', () => {
    const r = affectedUnits([
      'apps/admin-portal/src/features/performance/AgentPerformancePage.tsx',
      'apps/chat-widget/src/main.tsx',
    ]);
    expect(r).toEqual(
      expect.objectContaining({ all: false, images: [], services: [], portals: true }),
    );
  });

  it('a portal-only package (ui, reports, i18n, order-views): portals only', () => {
    for (const f of [
      'packages/ui/src/Button.tsx',
      'packages/reports/src/agent-performance.ts',
      'packages/i18n/src/index.ts',
      'packages/order-views/src/x.tsx',
    ]) {
      expect(affectedUnits([f])).toEqual(
        expect.objectContaining({ images: [], services: [], portals: true }),
      );
    }
  });

  it('docs, specs, the root e2e suite and unit tests deploy nothing', () => {
    const r = affectedUnits([
      'docs/YIJI-V2-TENANT.md',
      'README.md',
      'tests/e2e/login.spec.ts',
      'services/workers/tests/routing.test.ts',
      'apps/admin-portal/tests/agent-summary-export.test.ts',
    ]);
    expect(r).toEqual(
      expect.objectContaining({ all: false, images: [], services: [], portals: false }),
    );
  });

  it('a unit test beside a source change still deploys that source', () => {
    expect(
      affectedUnits(['services/workers/tests/routing.test.ts', 'services/workers/src/routing.ts'])
        .services,
    ).toEqual(['workers']);
  });

  it('Windows separators and ./ prefixes are normalised', () => {
    expect(unitsFor('services\\workers\\src\\a.ts')).toEqual(['workers']);
    expect(unitsFor('./apps/admin-portal/src/a.ts')).toEqual(['portals']);
  });
});

describe('affected services: the rules match what the images really contain', () => {
  const copies = (dockerfile: string) =>
    readFileSync(new URL(`../../../${dockerfile}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => /^COPY (?!--from)/.test(l))
      .map((l) => l.replace(/^COPY\s+/, '').split(/\s+/)[0]!)
      .filter(Boolean);

  it.each([
    ['services/workers/Dockerfile', 'workers'],
    ['services/socket-gateway/Dockerfile', 'socket-gateway'],
    ['services/ai-gateway/Dockerfile', 'ai-gateway'],
    ['directus/Dockerfile', 'directus'],
    ['directus/bootstrap/Dockerfile', 'bootstrap'],
  ])('every path %s COPYs redeploys %s (or everything)', (dockerfile, image) => {
    for (const src of copies(dockerfile)) {
      // A directory source: check a file inside it; a file: itself.
      const probe =
        src.endsWith('/') || !src.includes('.') ? `${src.replace(/\/$/, '')}/x.ts` : src;
      const u = unitsFor(probe);
      expect(
        u === 'ALL' || u.includes(image),
        `${dockerfile}: ${src} -> ${JSON.stringify(u)}`,
      ).toBe(true);
    }
  });
});
