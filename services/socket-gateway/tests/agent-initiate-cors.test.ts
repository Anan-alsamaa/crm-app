import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * A STAFF ENDPOINT UNDER `/chat/` NEEDS THE `authorization` HEADER ALLOWED.
 *
 * `/chat/agent-initiate` lives in that namespace only because that is what the
 * ALB routes to this service — a path outside `/chat/*` is answered by Directus
 * with "Route doesn't exist". But unlike every other route there, it is called
 * by the AGENT PORTAL with a Directus bearer token rather than by the
 * unauthenticated customer widget.
 *
 * The widget's CORS block allows `content-type` alone, which is correct for the
 * widget. Falling into it meant the preflight answered:
 *
 *     access-control-allow-headers: content-type
 *
 * while the portal asks to send `authorization, content-type`. The browser
 * refuses at the PREFLIGHT, so the request is never made and the error is
 * "Failed to fetch" with no response and no status — reported by the owner as
 * exactly that (2026-10-04).
 *
 * **Every command-line test of this endpoint passed**, because curl ignores
 * CORS entirely: 401 without a token, 404 on the wrong vendor id, 200 on the
 * right one. A green API test told us nothing about whether a browser could
 * call it. That is the lesson worth keeping.
 *
 * Asserted against the source: the server is constructed inside `start()`
 * behind Redis, Directus and a queue producer, so mocking all of that to read
 * one header would test the mocks.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

describe('CORS for the agent-initiate endpoint', () => {
  it('matches the one staff route by exact path, not by prefix', () => {
    /* A prefix would quietly widen the next widget endpoint somebody adds
       beside it — the widget routes are unauthenticated and must keep the
       narrower header set. */
    expect(SOURCE).toMatch(
      /const isStaffChatPath = \(url: string\) => url\.split\('\?'\)\[0\] === '\/chat\/agent-initiate'/,
    );
  });

  it('allows the authorization header', () => {
    const hook = SOURCE.slice(SOURCE.indexOf('isStaffChatPath = '));
    const block = hook.slice(0, hook.indexOf('isWidgetPath(req.url)'));
    expect(block).toMatch(/'Access-Control-Allow-Headers', 'content-type, authorization'/);
  });

  /* The STAFF portal's origin list, not the widget's — they are different
     allow-lists for different callers. */
  it('checks the origin against the staff list', () => {
    const hook = SOURCE.slice(SOURCE.indexOf('isStaffChatPath = '));
    const block = hook.slice(0, hook.indexOf('isWidgetPath(req.url)'));
    expect(block).toMatch(/allowCorsOrigin\(req\.headers\.origin\)/);
    expect(block).not.toMatch(/allowWidgetOrigin/);
  });

  /*
   * ORDER MATTERS. The widget hook runs after this one and would otherwise
   * overwrite the headers with its own narrower set, undoing the fix while
   * every line of it still read correctly.
   */
  it('stops the widget hook from overwriting it', () => {
    expect(SOURCE).toMatch(
      /if \(!isWidgetPath\(req\.url\) \|\| isStaffChatPath\(req\.url\)\) return;/,
    );
  });

  /* The widget routes keep the narrow set — this fix must not widen them. */
  it('leaves the widget routes allowing content-type only', () => {
    const widget = SOURCE.slice(SOURCE.indexOf('if (!isWidgetPath(req.url) || isStaffChatPath'));
    const block = widget.slice(0, widget.indexOf("if (req.method === 'OPTIONS')"));
    expect(block).toMatch(/'Access-Control-Allow-Headers', 'content-type'/);
    expect(block).not.toMatch(/authorization/);
  });

  /* The response must also be READABLE cross-origin — the global security
     `onSend` sets CORP `same-origin`, and `/chat/*` is already relaxed. */
  it('keeps the response readable cross-origin', () => {
    expect(SOURCE).toMatch(
      /isWidgetPath\(req\.url\)\)\s*\n?\s*reply\.header\('Cross-Origin-Resource-Policy', 'cross-origin'\)/,
    );
  });
});
