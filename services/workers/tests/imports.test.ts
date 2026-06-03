import { describe, expect, it, vi } from 'vitest';
import { parseCsv, findExistingContact } from '../src/processors/imports.js';
import type { YijiDirectusClient } from '@yiji/shared-config';

describe('parseCsv', () => {
  it('parses a plain header + rows', () => {
    const rows = parseCsv('name,email\nAlice,a@b.com\nBob,b@c.com');
    expect(rows).toEqual([
      ['name', 'email'],
      ['Alice', 'a@b.com'],
      ['Bob', 'b@c.com'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsv('name,note\n"Alice","x, y"\n');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Alice', 'x, y'],
    ]);
  });

  it('handles doubled quotes', () => {
    const rows = parseCsv('q\n"he said ""hi"""\n');
    expect(rows).toEqual([['q'], ['he said "hi"']]);
  });

  it('handles fields with newlines inside quotes', () => {
    const rows = parseCsv('a,b\n"hi\nthere","ok"');
    expect(rows).toEqual([
      ['a', 'b'],
      ['hi\nthere', 'ok'],
    ]);
  });

  it('drops a trailing empty row', () => {
    const rows = parseCsv('a,b\n1,2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('findExistingContact (per-vendor dedup)', () => {
  function fakeDirectus(returnRows: Array<{ id: string }>): YijiDirectusClient {
    return {
      request: vi.fn(async () => returnRows),
    } as unknown as YijiDirectusClient;
  }

  it('returns null when no identifiers are provided', async () => {
    const d = fakeDirectus([{ id: 'should-not-match' }]);
    const id = await findExistingContact(d, 'v1', {});
    expect(id).toBeNull();
    // No request made because no identifiers.
    expect((d.request as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns the matched id when one row comes back', async () => {
    const d = fakeDirectus([{ id: 'c-existing' }]);
    const id = await findExistingContact(d, 'v1', { phone: '+1', email: 'a@b.com' });
    expect(id).toBe('c-existing');
  });

  it('returns null when no matches', async () => {
    const d = fakeDirectus([]);
    const id = await findExistingContact(d, 'v1', { phone: '+9999' });
    expect(id).toBeNull();
  });
});
