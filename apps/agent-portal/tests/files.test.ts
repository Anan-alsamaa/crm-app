import { describe, it, expect } from 'vitest';
import {
  fileKind,
  formatBytes,
  fileLabel,
  isImage,
  validateAttachment,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_ACCEPT,
} from '../src/lib/files.js';

function fakeFile(name: string, type: string, size: number): File {
  // jsdom's File ignores the blob content's real size, so override `size`.
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('fileKind', () => {
  it('classifies by MIME type', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind('text/csv')).toBe('sheet');
    expect(
      fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('doc');
    expect(fileKind('text/plain')).toBe('text');
    expect(fileKind('application/zip')).toBe('archive');
    expect(fileKind('audio/mpeg')).toBe('audio');
    expect(fileKind('video/mp4')).toBe('video');
  });

  it('falls back to the filename extension when the MIME is unknown', () => {
    expect(fileKind(null, 'report.docx')).toBe('doc');
    expect(fileKind('', 'data.xlsx')).toBe('sheet');
    expect(fileKind(null, 'archive.zip')).toBe('archive');
    expect(fileKind(null, 'mystery')).toBe('file');
  });

  it('isImage is true only for images', () => {
    expect(isImage('image/jpeg')).toBe(true);
    expect(isImage('application/pdf', 'x.pdf')).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(245760)).toBe('240 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('returns empty string for missing/invalid sizes', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-5)).toBe('');
  });
});

describe('validateAttachment', () => {
  it('accepts allowed types within the size limit', () => {
    expect(validateAttachment(fakeFile('a.png', 'image/png', 1024))).toBeNull();
    expect(validateAttachment(fakeFile('a.jpg', 'image/jpeg', 1024))).toBeNull();
    expect(validateAttachment(fakeFile('a.pdf', 'application/pdf', 1024))).toBeNull();
    expect(validateAttachment(fakeFile('a.txt', 'text/plain', 1024))).toBeNull();
  });

  it('rejects disallowed types', () => {
    expect(validateAttachment(fakeFile('a.docx', 'application/msword', 1024))).toBe('type');
    expect(validateAttachment(fakeFile('a.zip', 'application/zip', 1024))).toBe('type');
    expect(validateAttachment(fakeFile('a.svg', 'image/svg+xml', 1024))).toBe('type');
    expect(validateAttachment(fakeFile('a.mp4', 'video/mp4', 1024))).toBe('type');
  });

  it('rejects files over the size limit', () => {
    expect(validateAttachment(fakeFile('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1))).toBe(
      'size',
    );
  });

  it('falls back to the extension when the browser reports no MIME', () => {
    expect(validateAttachment(fakeFile('notes.txt', '', 1024))).toBeNull();
    expect(validateAttachment(fakeFile('photo.JPG', '', 1024))).toBeNull();
    expect(validateAttachment(fakeFile('mystery', '', 1024))).toBe('type');
    expect(validateAttachment(fakeFile('book.epub', '', 1024))).toBe('type');
  });

  it('exposes an accept filter covering the allowed types', () => {
    expect(ATTACHMENT_ACCEPT).toContain('application/pdf');
    expect(ATTACHMENT_ACCEPT).toContain('.png');
  });
});

describe('fileLabel', () => {
  it('prefers the uppercased extension', () => {
    expect(fileLabel('report.pdf', null)).toBe('PDF');
    expect(fileLabel('photo.png', 'image/png')).toBe('PNG');
  });

  it('falls back to a capitalized kind', () => {
    expect(fileLabel(null, 'application/pdf')).toBe('Pdf');
    expect(fileLabel('noextension', null)).toBe('File');
  });
});
