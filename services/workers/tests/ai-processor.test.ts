import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { AiJob } from '@yiji/shared-types';
import { processAiJob, type AiDeps } from '../src/processors/ai.js';

/**
 * processAiJob calls the AI gateway over fetch and persists the result back to
 * Directus. We stub global.fetch and the Directus client's request().
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: () => undefined,
  debug: () => undefined,
} as never;

function makeDeps(): { deps: AiDeps; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ vendor: 'vendor-1' })); // loadVendor read
  const deps: AiDeps = {
    directus: { request } as never,
    gatewayUrl: 'http://ai-gateway:8081',
    gatewayToken: 'svc-ai',
    workerUserId: 'worker-user',
    logger: silentLogger,
  };
  return { deps, request };
}

function jobFor(data: AiJob): Job<AiJob> {
  return { data } as Job<AiJob>;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
}

describe('processAiJob', () => {
  it('summarize: calls the gateway with auth headers and stores ai_summary', async () => {
    const { deps, request } = makeDeps();
    fetchMock.mockResolvedValueOnce(okJson({ summary: 'A short summary.' }));
    await processAiJob(jobFor({ job: 'summarize', conversationId: 'conv-1' }), deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/summarize-conversation');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer svc-ai',
      'x-yiji-user': 'worker-user',
      'x-yiji-vendor': 'vendor-1',
    });
    // Last directus.request is the updateItem persisting the summary.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('score_lead: stores score + signals', async () => {
    const { deps } = makeDeps();
    fetchMock.mockResolvedValueOnce(okJson({ score: 72, signals: ['responsive', 'repeat'] }));
    await processAiJob(jobFor({ job: 'score_lead', conversationId: 'conv-2' }), deps);
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ score: 72 }),
      expect.any(String),
    );
  });

  it('throws when the gateway returns a non-OK status', async () => {
    const { deps } = makeDeps();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as Response);
    await expect(
      processAiJob(jobFor({ job: 'summarize', conversationId: 'conv-1' }), deps),
    ).rejects.toThrow(/429/);
  });

  it('defaults vendor to "unknown" when the conversation has none', async () => {
    const { deps, request } = makeDeps();
    request.mockReset();
    request.mockResolvedValueOnce(null).mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(okJson({ summary: 'x' }));
    await processAiJob(jobFor({ job: 'summarize', conversationId: 'conv-3' }), deps);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ 'x-yiji-vendor': 'unknown' });
  });
});
