import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * THE GATEWAY MUST ALLOW EVERY HEADER THE WIDGET ACTUALLY SENDS.
 *
 * Customers could not send a photo, twice (owner, 2026-09-30 and 2026-10-05).
 * `POST /chat/attachment` sends `Authorization: Bearer …`, but the widget CORS
 * block allowed `content-type` alone — so every browser refused the upload at
 * the PREFLIGHT and the POST never left the phone. Production logged only
 * OPTIONS for every attempt. Every check of the endpoint had been made with
 * curl, which ignores CORS, so it all "passed".
 *
 * A hand-written expectation would only restate whatever the source says (the
 * previous version of this guard asserted the narrow list, and so locked the
 * bug in). This test DERIVES the headers from the widget's own `fetch` calls to
 * the gateway and checks each against the gateway's allowed list. Adding a
 * header on one side without the other now fails the build.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GATEWAY = readFileSync(join(ROOT, 'services/socket-gateway/src/index.ts'), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Header names (lowercased) set by widget `fetch` calls to /chat/* or /walk-in/*. */
function widgetHeaders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(join(ROOT, 'apps/chat-widget/src'))) {
    const src = readFileSync(file, 'utf8');
    const re = /fetch\(\s*`[^`]*\/(chat|walk-in)\/[^`]*`\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
    for (const m of src.matchAll(re)) {
      const headersBlock = /headers:\s*\{([\s\S]*?)\}/.exec(m[2]!)?.[1] ?? '';
      const names = [...headersBlock.matchAll(/(?:^|[,{\s])'?([A-Za-z-]+)'?\s*:/g)].map((h) =>
        h[1]!.toLowerCase(),
      );
      found.set(`${file.slice(ROOT.length)}:${m.index}`, names);
    }
  }
  return found;
}

const allowed = (/const WIDGET_CORS_ALLOW_HEADERS = '([^']+)'/.exec(GATEWAY)?.[1] ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

describe('widget CORS covers what the widget sends', () => {
  it('finds the widget calls it is meant to guard', () => {
    // If this drops to zero the derivation broke and the guard below would
    // pass vacuously — which is how a guard silently stops guarding.
    const calls = widgetHeaders();
    expect(calls.size).toBeGreaterThanOrEqual(2);
    expect([...calls.values()].flat()).toContain('authorization');
  });

  it('allows every header any widget call sends', () => {
    for (const [where, names] of widgetHeaders()) {
      for (const name of names) {
        expect(allowed, `${where} sends "${name}"`).toContain(name);
      }
    }
  });

  it('applies that list on the widget routes', () => {
    expect(GATEWAY).toMatch(
      /reply\.header\('Access-Control-Allow-Headers', WIDGET_CORS_ALLOW_HEADERS\)/,
    );
  });
});
