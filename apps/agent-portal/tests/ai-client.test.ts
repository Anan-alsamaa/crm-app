import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { ai, type AiCaller } from '../src/lib/ai-client.js';

/** ai-client is a thin fetch wrapper. Stub global fetch and assert each method
 * targets the right endpoint with caller headers, plus the error mapping. */

const fetchMock = vi.fn();
const caller: AiCaller = { userId: 'u-1', vendorId: 'v-1' };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('ai-client happy paths', () => {
  it('summarize posts to the summarize endpoint with caller headers', async () => {
    fetchMock.mockResolvedValueOnce(ok({ summary: 'done' }));
    const out = await ai.summarize(caller, 'conv-1');
    expect(out).toEqual({ summary: 'done' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(AI_ENDPOINTS.summarizeConversation);
    expect((init as RequestInit).headers).toMatchObject({
      authorization: expect.stringContaining('Bearer'),
      'x-yiji-user': 'u-1',
      'x-yiji-vendor': 'v-1',
    });
  });

  it('routes each helper to its endpoint', async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [
        () => ai.suggestReply(caller, 'c', { draft: 'hi', locale: 'en' }),
        AI_ENDPOINTS.suggestReply,
      ],
      [() => ai.sentiment(caller, 'c'), AI_ENDPOINTS.analyzeSentiment],
      [() => ai.intent(caller, 'c'), AI_ENDPOINTS.detectIntent],
      [() => ai.entities(caller, 'c'), AI_ENDPOINTS.extractEntities],
      [() => ai.search(caller, 'refund', 5), AI_ENDPOINTS.semanticSearch],
      [() => ai.scoreLead(caller, 'c'), AI_ENDPOINTS.scoreLead],
    ];
    for (const [run, endpoint] of cases) {
      fetchMock.mockResolvedValueOnce(ok({}));
      await run();
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(endpoint);
    }
  });
});

describe('ai-client error mapping', () => {
  it('throws an AiError carrying status, code and retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limited', retryAfterMs: 3000 }),
    } as Response);
    await expect(ai.summarize(caller, 'c')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterMs: 3000,
    });
  });

  it('still throws when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as Response);
    await expect(ai.sentiment(caller, 'c')).rejects.toMatchObject({ status: 500 });
  });
});
