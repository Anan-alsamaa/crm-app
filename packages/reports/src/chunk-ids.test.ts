import { describe, expect, it, vi } from 'vitest';
import { chunkIds, IN_FILTER_CHUNK, readChunked } from './chunk-ids.js';

/**
 * These guard a fault that is invisible until production data grows: a few
 * hundred ids in a Directus `_in` filter overflow the query string and
 * CloudFront answers HTTP 414 before the request reaches any service. The
 * admin ticket-breakdown report failed exactly this way at 232 conversations.
 */
describe('chunkIds', () => {
  it('returns nothing for an empty set', () => {
    expect(chunkIds([])).toEqual([]);
  });

  it('keeps a set below the limit in one piece', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id-${i}`);
    expect(chunkIds(ids)).toEqual([ids]);
  });

  it('splits on the boundary without dropping or duplicating an id', () => {
    const ids = Array.from({ length: 232 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(IN_FILTER_CHUNK);
    expect(chunks[1]).toHaveLength(232 - IN_FILTER_CHUNK);
    expect(chunks.flat()).toEqual(ids);
  });

  it('splits an exact multiple into equal chunks with no empty tail', () => {
    const ids = Array.from({ length: IN_FILTER_CHUNK * 3 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === IN_FILTER_CHUNK)).toBe(true);
  });

  it('rejects a nonsensical chunk size rather than looping for ever', () => {
    expect(() => chunkIds(['a'], 0)).toThrow(RangeError);
  });

  /** The real constraint: a chunk must stay under CloudFront's ~8KB URL cap. */
  it('keeps an encoded uuid chunk well under the URL limit', () => {
    const uuids = Array.from(
      { length: IN_FILTER_CHUNK },
      () => '00000000-0000-4000-8000-000000000000',
    );
    const encoded = encodeURIComponent(JSON.stringify({ conversation: { _in: uuids } }));
    expect(encoded.length).toBeLessThan(8000);
  });
});

describe('readChunked', () => {
  it('makes no request at all for an empty set', async () => {
    const read = vi.fn();
    await expect(readChunked([], read)).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('concatenates every chunk in order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const read = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })));
    const rows = await readChunked(ids, read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it('propagates a failure instead of silently returning a partial set', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const read = vi.fn(async (chunk: string[]) => {
      if (chunk[0] !== 'id-0') throw new Error('boom');
      return chunk.map((id) => ({ id }));
    });
    await expect(readChunked(ids, read)).rejects.toThrow('boom');
  });
});
