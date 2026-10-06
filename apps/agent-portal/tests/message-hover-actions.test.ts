import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, 2026-10-06: beside a sent message, the Copy button is replaced by
 * Edit, and it shows only while that specific message is hovered.
 */
const VIEW = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/ConversationView.tsx'),
  'utf8',
);
const CONTROLS = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/MessageEditControls.tsx'),
  'utf8',
);

describe('hover actions beside a message', () => {
  it('shows Edit/Delete INSTEAD of Copy on an own changeable reply', () => {
    // One or the other, never both side by side.
    expect(VIEW).toMatch(/\{ownActions \? \(\s*<OwnMessageActions/);
    expect(VIEW).not.toMatch(/\{ownActions && \(\s*<OwnMessageActions\s+canEdit\s+onEdit/);
  });

  it('keeps Copy for every other message', () => {
    expect(VIEW).toMatch(/\) : \(\s*<button[\s\S]{0,200}copyMessage/);
  });

  it('reveals Edit/Delete only while that message is hovered', () => {
    const cls = /const ICON_BUTTON =\s*'([^']+)'/.exec(CONTROLS)?.[1] ?? '';
    expect(cls).toMatch(/\bopacity-0\b/);
    expect(cls).toMatch(/group-hover\/msg:opacity-100/);
    expect(cls).toMatch(/focus-visible:opacity-100/);
  });
});
