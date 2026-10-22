import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * FILTERS STAY IN VIEW; ONLY THE TABLE SCROLLS SIDEWAYS (owner, 2026-10-13).
 *
 * A report whose content is `w-max min-w-full` scrolls sideways as a whole. The
 * filter bar and KPI strip pin themselves (`sticky start-0
 * w-[var(--pin-w,100%)]`), but `--pin-w` is set by `usePinnedWidth` on the
 * scrollport. A page that forgot the ref gave them the TABLE'S width, and the
 * Late orders report's date fields sat off to the right. Every such page must
 * attach the ref.
 */
const APPS = fileURLToPath(new URL('../../../apps', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

describe('pinned scrollports', () => {
  const pages = ['agent-portal', 'admin-portal']
    .flatMap((app) => tsxFiles(join(APPS, app, 'src')))
    .filter((f) => readFileSync(f, 'utf8').includes('w-max min-w-full'));

  /* The admin reports no longer scroll sideways as a whole (Rapport skin,
     owner 2026-10-22): their wide tables scroll INSIDE the card, so only the
     agent portal's Late orders page still takes this shape. The guard stays
     for it and for any page that returns to the pattern. */
  it('finds the sideways-scrolling report pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it.each(pages)('%s attaches usePinnedWidth to its scrollport', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/usePinnedWidth\(/);
    expect(src).toMatch(/ref=\{pinRef\}/);
  });
});
