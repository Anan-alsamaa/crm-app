import { describe, it, expect } from 'vitest';
import {
  validateAttachments,
  parseAttachmentPolicy,
  decodeUploadContent,
  type AttachmentMeta,
} from '../src/attachments.js';

const policy = parseAttachmentPolicy(1_000_000, 'image/png, image/jpeg ,application/pdf');

const meta = (over: Partial<AttachmentMeta> & { id: string }): AttachmentMeta => ({
  type: 'image/png',
  filesize: 1234,
  ...over,
});

describe('parseAttachmentPolicy', () => {
  it('trims, lowercases and drops empties', () => {
    expect(policy.maxBytes).toBe(1_000_000);
    expect(policy.allowedMime).toEqual(['image/png', 'image/jpeg', 'application/pdf']);
  });
});

describe('decodeUploadContent', () => {
  const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);

  it('decodes a whole ArrayBuffer', () => {
    const ab = bytes.buffer.slice(0); // standalone ArrayBuffer, offset 0
    const buf = decodeUploadContent(ab);
    expect(buf).not.toBeNull();
    expect(Uint8Array.from(buf!)).toEqual(bytes);
  });

  it('decodes a base64 string (polling transport)', () => {
    const buf = decodeUploadContent(Buffer.from(bytes).toString('base64'));
    expect(Uint8Array.from(buf!)).toEqual(bytes);
  });

  it('copies ONLY the view window when the Buffer is a slice of a larger pool', () => {
    // Reproduces the corruption bug: Socket.IO delivers binary as a Node Buffer
    // that is a slice of a larger pooled ArrayBuffer (non-zero byteOffset,
    // byteLength < underlying buffer). Reading `.buffer` wholesale would return
    // the surrounding pool bytes and the wrong length.
    const pool = Buffer.alloc(64, 0x99); // simulate a shared allocation pool
    bytes.forEach((b, i) => (pool[10 + i] = b)); // our payload lives at offset 10
    const view = pool.subarray(10, 10 + bytes.length); // offset 10, len 6
    expect(view.byteOffset).toBe(10);

    const buf = decodeUploadContent(view);
    expect(buf!.length).toBe(bytes.length); // exact length, not 64
    expect(Uint8Array.from(buf!)).toEqual(bytes); // exact bytes, no pool garbage
  });

  it('returns null for empty or unusable content', () => {
    expect(decodeUploadContent(new ArrayBuffer(0))).toBeNull();
    expect(decodeUploadContent(Buffer.alloc(0))).toBeNull();
    expect(decodeUploadContent(undefined)).toBeNull();
    expect(decodeUploadContent(42)).toBeNull();
  });
});

describe('validateAttachments', () => {
  it('passes with no attachments', () => {
    expect(validateAttachments([], [], policy).ok).toBe(true);
  });

  it('accepts allowed type within size', () => {
    const r = validateAttachments(['a'], [meta({ id: 'a' })], policy);
    expect(r.ok).toBe(true);
  });

  it('rejects an id with no resolved file', () => {
    const r = validateAttachments(['a', 'missing'], [meta({ id: 'a' })], policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it('rejects a disallowed MIME type', () => {
    const r = validateAttachments(
      ['a'],
      [meta({ id: 'a', type: 'application/x-msdownload' })],
      policy,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/);
  });

  it('rejects a file over the size cap', () => {
    const r = validateAttachments(['a'], [meta({ id: 'a', filesize: 1_000_001 })], policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/limit/);
  });

  it('rejects unknown (null) size', () => {
    const r = validateAttachments(['a'], [meta({ id: 'a', filesize: null })], policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown size/);
  });

  it('rejects null/empty MIME type', () => {
    const r = validateAttachments(['a'], [meta({ id: 'a', type: null })], policy);
    expect(r.ok).toBe(false);
  });

  it('is case-insensitive on the MIME type', () => {
    const r = validateAttachments(['a'], [meta({ id: 'a', type: 'IMAGE/PNG' })], policy);
    expect(r.ok).toBe(true);
  });
});
