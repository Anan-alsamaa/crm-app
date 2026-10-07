import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, 2026-10-06: the actions beside a message show only while it is
 * hovered. SUPERSEDED IN PART by the owner on 2026-10-07: "instead of 2
 * buttons let there be icons — like WhatsApp, they can select a message and
 * delete or modify it". So the bar is icons (copy, plus pencil + trash on an
 * own changeable reply), pinned while the message is SELECTED by a click, and
 * still previewed on hover.
 */
const VIEW = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/ConversationView.tsx'),
  'utf8',
);
const CONTROLS = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/MessageEditControls.tsx'),
  'utf8',
);

describe('message actions beside a message', () => {
  it('offers Copy on every message, and Edit/Delete only on an own changeable reply', () => {
    expect(VIEW).toMatch(/<MessageActions[\s\S]{0,120}onCopy=\{\(\) => copyMessage/);
    expect(VIEW).toMatch(/onEdit=\{\s*ownActions/);
    expect(VIEW).toMatch(/onDelete=\{\s*ownActions/);
  });

  it('icons, not the words "Edit" / "Delete"', () => {
    expect(CONTROLS).not.toContain("t('conversation.editShort'");
    expect(CONTROLS).not.toContain("t('conversation.deleteShort'");
  });

  it('pinned while selected, otherwise revealed by hover or keyboard focus', () => {
    expect(CONTROLS).toMatch(/selected\s*\?\s*'opacity-100'/);
    expect(CONTROLS).toMatch(/opacity-0 focus-within:opacity-100 group-hover\/msg:opacity-100/);
  });
});
