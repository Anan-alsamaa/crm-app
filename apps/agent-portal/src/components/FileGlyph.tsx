import type { JSX } from 'react';
import { cn } from '@yiji/ui';
import { fileKind, type FileKind } from '../lib/files.js';

/**
 * A small rounded tile with a type-appropriate glyph + subtle tone, so a PDF
 * doesn't look like a spreadsheet looks like a zip. Tones stay muted (the teal
 * brand accent is reserved for primary actions, not file chrome).
 */

const PATHS: Record<FileKind, JSX.Element> = {
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </>
  ),
  pdf: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  doc: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M8.5 13h7M8.5 16.5h7" />
    </>
  ),
  sheet: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M4 15h16M10 4v16" />
    </>
  ),
  text: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M8.5 12.5h7M8.5 16h4" />
    </>
  ),
  archive: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 4v3M12 9v2M12 13v2" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V7l9-2v11" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="15" cy="16" r="2.5" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3z" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
};

const TONE: Record<FileKind, string> = {
  image: 'bg-primary-subtle text-primary',
  pdf: 'bg-rose-500/12 text-rose-500',
  doc: 'bg-sky-500/12 text-sky-500',
  sheet: 'bg-emerald-500/12 text-emerald-500',
  text: 'bg-secondary text-muted-foreground',
  archive: 'bg-amber-500/14 text-amber-500',
  audio: 'bg-violet-500/12 text-violet-500',
  video: 'bg-indigo-500/12 text-indigo-500',
  file: 'bg-secondary text-muted-foreground',
};

export function FileGlyph({
  type,
  filename,
  size = 'md',
  className,
}: {
  type: string | null | undefined;
  filename?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}): JSX.Element {
  const kind = fileKind(type, filename);
  const box = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const icon = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-lg', box, TONE[kind], className)}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={icon}
      >
        {PATHS[kind]}
      </svg>
    </span>
  );
}
