import { describe, it, expect } from 'vitest';
import { readChunked } from '../src/chunk-ids.js';

/**
 * Chunks may run in parallel (the ticket breakdown's revision lookup was ~67
 * chunks in series after the historic import), but callers rely on "the first
 * row seen wins", so the answer must still come back in CHUNK ORDER.
 */
describe('readChunked', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);

  it('keeps chunk order even when later chunks finish first', async () => {
    const out = await readChunked(
      ids,
      async (chunk) => {
        // Earlier chunks are slower, so a naive push would reorder them.
        await new Promise((r) => setTimeout(r, 30 - Number(chunk[0]!.slice(2)) * 3));
        return chunk;
      },
      3,
      4,
    );
    expect(out).toEqual(ids);
  });

  it('never has more than the allowed number in flight', async () => {
    let live = 0;
    let peak = 0;
    await readChunked(
      ids,
      async (chunk) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return chunk;
      },
      1,
      3,
    );
    expect(peak).toBe(3);
  });

  it('defaults to one at a time', async () => {
    let live = 0;
    let peak = 0;
    await readChunked(
      ids,
      async (chunk) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1));
        live--;
        return chunk;
      },
      2,
    );
    expect(peak).toBe(1);
  });
});
