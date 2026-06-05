import { describe, it, expect } from 'vitest';
import {
  validateAttachments,
  parseAttachmentPolicy,
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
