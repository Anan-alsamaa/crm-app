import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ImportJob } from '@yiji/shared-types';
import { processImportJob, type ImportsDeps } from '../src/processors/imports.js';

/**
 * processImportJob downloads a CSV from the Directus asset endpoint (fetch),
 * maps columns, dedups per vendor, and upserts contacts. We stub fetch + the
 * Directus client. Each contact lookup + create is a request() call we sequence.
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: () => undefined,
  debug: () => undefined,
} as never;
const fetchMock = vi.fn();

function makeDeps(): { deps: ImportsDeps; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => undefined); // default: readFile metadata + others
  const deps: ImportsDeps = {
    directus: { request } as never,
    directusUrl: 'http://directus:8055',
    directusToken: 'svc-token',
    logger: silentLogger,
  };
  return { deps, request };
}

function jobFor(data: ImportJob): Job<ImportJob> {
  return { data } as Job<ImportJob>;
}

const mapping = { Name: 'name', Email: 'email', Phone: 'phone' };

function csvResponse(text: string): Response {
  return { ok: true, status: 200, text: async () => text } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('processImportJob', () => {
  it('throws when the asset download fails', async () => {
    const { deps, request } = makeDeps();
    request.mockResolvedValueOnce(undefined); // readFile metadata
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(
      processImportJob(jobFor({ fileId: 'f1', vendorId: 'v1', mapping }), deps),
    ).rejects.toThrow(/failed to fetch import file/);
  });

  it('returns an all-zero summary for an empty file', async () => {
    const { deps, request } = makeDeps();
    request.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(csvResponse(''));
    const summary = await processImportJob(jobFor({ fileId: 'f1', vendorId: 'v1', mapping }), deps);
    expect(summary).toEqual({ total: 0, created: 0, duplicates: 0, skipped: 0, results: [] });
  });

  it('creates new contacts, flags duplicates, and skips identifier-less rows', async () => {
    const { deps, request } = makeDeps();
    const csv = [
      'Name,Email,Phone',
      'Alice,alice@example.com,+1000', // new → create
      'Bob,bob@example.com,+2000', // dedup hit → duplicate
      'NoId,,', // no identifier → skipped
    ].join('\n');

    request.mockReset();
    request
      .mockResolvedValueOnce(undefined) // readFile metadata
      .mockResolvedValueOnce([]) // Alice: findExistingContact miss
      .mockResolvedValueOnce({ id: 'c-alice' }) // Alice: createItem
      .mockResolvedValueOnce([{ id: 'c-bob' }]); // Bob: findExistingContact hit
    fetchMock.mockResolvedValueOnce(csvResponse(csv));

    const summary = await processImportJob(jobFor({ fileId: 'f1', vendorId: 'v1', mapping }), deps);
    expect(summary.total).toBe(3);
    expect(summary.created).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.results).toEqual([
      { row: 1, action: 'created', contactId: 'c-alice' },
      { row: 2, action: 'duplicate', contactId: 'c-bob' },
      { row: 3, action: 'skipped', reason: 'no identifier' },
    ]);
  });

  it('records a skipped row when the create request throws', async () => {
    const { deps, request } = makeDeps();
    const csv = 'Name,Email,Phone\nCarol,carol@example.com,+3000';
    request.mockReset();
    request
      .mockResolvedValueOnce(undefined) // readFile
      .mockResolvedValueOnce([]) // dedup miss
      .mockRejectedValueOnce(new Error('insert blew up')); // create throws
    fetchMock.mockResolvedValueOnce(csvResponse(csv));

    const summary = await processImportJob(jobFor({ fileId: 'f1', vendorId: 'v1', mapping }), deps);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]).toMatchObject({ action: 'skipped', reason: 'insert blew up' });
  });
});
