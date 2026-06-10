import { describe, it, expect } from 'vitest';
import { fileKind, formatBytes, fileLabel, isImage } from '../src/lib/files.js';

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
