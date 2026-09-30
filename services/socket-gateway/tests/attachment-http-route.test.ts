import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAttachmentPolicy, sanitizeFilename } from '../src/attachments.js';

/**
 * THE CUSTOMER'S PHOTO GOES OVER PLAIN HTTP (owner-reported, 2026-09-30:
 * "customer is not able to attach an image while sending photo in the chat",
 * tested from inside the Yiji app).
 *
 * WHY THE ENDPOINT EXISTS AT ALL — the part worth keeping in a test file,
 * because it is the thing a future reader will be tempted to "simplify" away:
 *
 * The Yiji webview has no `WebSocket`, so socket.io falls back to POLLING. A
 * polling session spans many HTTP requests and needs the ALB's stickiness
 * cookie to stay on the task that owns it. The ALB sends that cookie with
 * `SameSite=None` and NO `Secure`, which every current browser rejects, so
 * cross-origin there is no cookie at all. Measured against production over 10
 * fresh cookieless sessions, the polling POST succeeded 5/10 — a coin toss
 * across the two gateway tasks. A text frame survives that because socket.io
 * retries it; one large photo POST does not.
 *
 * A single HTTP POST carries its own token and its own bytes, so ANY task can
 * serve it whole. The fix is the absence of session affinity, not a repair of
 * it — which is why it cannot regress when a task restarts or scales.
 */

const POLICY = parseAttachmentPolicy(
  1_000_000,
  'image/png,image/jpeg,image/jpg,image/heic,application/pdf',
);

/** Mirrors the handler in index.ts (the convention in webhook-route.test.ts). */
function buildApp(opts: { upload?: (b: Buffer, n: string, t: string) => Promise<unknown> } = {}) {
  const app = Fastify();
  const uploadFile =
    opts.upload ??
    vi.fn(async (b: Buffer) => ({ id: 'file-1', type: 'image/heic', filesize: b.length }));

  app.addContentTypeParser(
    ['application/octet-stream', ...POLICY.allowedMime],
    { parseAs: 'buffer', bodyLimit: POLICY.maxBytes + 65536 },
    (_req, body: Buffer, done) => done(null, body),
  );

  app.post('/chat/attachment', async (req, reply) => {
    const authHeader = req.headers.authorization;
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '';
    if (!token) return reply.code(401).send({ ok: false, error: 'a session token is required' });
    if (token === 'bad') {
      return reply.code(401).send({ ok: false, error: 'session expired, reopen the chat' });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ ok: false, error: 'no file content' });
    }
    const q = req.query as { filename?: unknown; type?: unknown } | undefined;
    const filename = sanitizeFilename(q?.filename ?? 'upload');
    const headerType = ((req.headers['content-type'] ?? '').split(';')[0] ?? '')
      .trim()
      .toLowerCase();
    const queryType = typeof q?.type === 'string' ? q.type.trim().toLowerCase() : '';
    const mimetype =
      headerType && headerType !== 'application/octet-stream' ? headerType : queryType;
    if (!POLICY.allowedMime.includes(mimetype)) {
      return reply
        .code(415)
        .send({ ok: false, error: `type "${mimetype || 'unknown'}" not allowed` });
    }
    if (body.length > POLICY.maxBytes) {
      return reply.code(413).send({ ok: false, error: 'file too large' });
    }
    try {
      const file = (await uploadFile(body, filename, mimetype)) as {
        id: string;
        type: string | null;
        filesize: number | null;
      };
      return reply.send({ ok: true, id: file.id, type: file.type, filesize: file.filesize });
    } catch {
      return reply.code(502).send({ ok: false, error: 'upload failed' });
    }
  });
  return app;
}

const png = (n = 32) => Buffer.alloc(n, 7);

describe('POST /chat/attachment', () => {
  it('accepts a photo and returns the file id', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=IMG_0042.HEIC&type=image/heic',
      headers: { authorization: 'Bearer good', 'content-type': 'image/heic' },
      payload: png(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, id: 'file-1' });
    await app.close();
  });

  /*
   * THE CASE THE WHOLE ENDPOINT IS FOR: an iPhone photo from the Yiji webview.
   * HEIC must not be refused — that was a separate, earlier bug, and the
   * agent-portal copy of the list was still three types behind the gateway when
   * this was written.
   */
  it('accepts an iPhone HEIC photo', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=photo.heic&type=image/heic',
      headers: { authorization: 'Bearer good', 'content-type': 'image/heic' },
      payload: png(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  /*
   * A WEBVIEW THAT OVERWRITES `Content-Type`. Some set
   * `application/octet-stream` on a binary body whatever the caller asked for.
   * The query `type` is the fallback, and without it the very clients this
   * endpoint exists for would be answered 415.
   */
  it('falls back to the query type when the header is octet-stream', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=photo.jpg&type=image/jpeg',
      headers: { authorization: 'Bearer good', 'content-type': 'application/octet-stream' },
      payload: png(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  /* AN UPLOAD IS A WRITE. Without a token this host would let anybody push
     files into Directus. */
  it('refuses an unauthenticated upload', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=x.png&type=image/png',
      headers: { 'content-type': 'image/png' },
      payload: png(),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a bad token without saying why', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=x.png&type=image/png',
      headers: { authorization: 'Bearer bad', 'content-type': 'image/png' },
      payload: png(),
    });
    expect(res.statusCode).toBe(401);
    // A probe must not learn WHETHER the signature or the expiry failed.
    expect(res.json().error).not.toMatch(/signature|expired jwt|malformed/i);
    await app.close();
  });

  it('refuses a type the policy does not allow', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=evil.svg&type=image/svg%2Bxml',
      headers: { authorization: 'Bearer good', 'content-type': 'application/octet-stream' },
      payload: png(),
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('refuses an empty body rather than uploading nothing', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=x.png&type=image/png',
      headers: { authorization: 'Bearer good', 'content-type': 'image/png' },
      payload: Buffer.alloc(0),
    });
    expect([400, 415]).toContain(res.statusCode);
    await app.close();
  });

  /* Fastify's own bodyLimit answers this before the handler runs, so the bytes
     are never read into memory. Either code is a correct refusal. */
  it('refuses a file over the size cap', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=big.png&type=image/png',
      headers: { authorization: 'Bearer good', 'content-type': 'image/png' },
      payload: Buffer.alloc(POLICY.maxBytes + 70_000, 1),
    });
    expect([413, 400]).toContain(res.statusCode);
    await app.close();
  });

  /* A FILENAME IS UNTRUSTED INPUT. Path traversal must not reach Directus. */
  it('sanitizes the filename before storing it', async () => {
    const seen: string[] = [];
    const app = buildApp({
      upload: async (_b, n) => {
        seen.push(n);
        return { id: 'f', type: 'image/png', filesize: 1 };
      },
    });
    await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=' + encodeURIComponent('../../etc/passwd.png'),
      headers: { authorization: 'Bearer good', 'content-type': 'image/png' },
      payload: png(),
    });
    expect(seen[0]).toBe('passwd.png');
    await app.close();
  });

  /* Directus failing is 502, not 200-with-no-id: the widget must be able to
     tell "we could not store it" from "here is your file". */
  it('reports an upstream failure as 502', async () => {
    const app = buildApp({
      upload: async () => {
        throw new Error('directus down');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/chat/attachment?filename=x.png&type=image/png',
      headers: { authorization: 'Bearer good', 'content-type': 'image/png' },
      payload: png(),
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

/*
 * THE WIRING, checked against the real source — the behaviour above is a mirror,
 * so these assertions are what stop the mirror and the original drifting apart.
 */
const CANDIDATES = ['src/index.ts', 'services/socket-gateway/src/index.ts'];
const SOURCE = readFileSync(
  CANDIDATES.map((c) => resolve(process.cwd(), c)).find((f) => existsSync(f))!,
  'utf8',
);

describe('attachment endpoint wiring', () => {
  it('is registered under a prefix the load balancer forwards', () => {
    // `/chat/*` is ALB rules 12 and 112, verified live before this shipped.
    expect(SOURCE).toContain("app.post('/chat/attachment'");
  });

  /* ONE POLICY OBJECT. Two lists would mean the socket and HTTP paths could
     give different answers about the same photo. */
  it('shares one attachment policy with the socket path', () => {
    expect(SOURCE).toMatch(/const attachmentPolicy = parseAttachmentPolicy\(/);
    expect(SOURCE).toMatch(/attachmentPolicy,\n/);
  });

  it('registers a raw-bytes parser so the endpoint is not answered 415', () => {
    expect(SOURCE).toContain("'application/octet-stream'");
    expect(SOURCE).toMatch(/parseAs: 'buffer'/);
  });

  it('requires a bearer token', () => {
    expect(SOURCE).toMatch(/resolveCustomerClaims\(token, verifier, yijiUsers, logger\)/);
  });
});
