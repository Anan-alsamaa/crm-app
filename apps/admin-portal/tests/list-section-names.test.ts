import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, 2026-10-05: every list in "Dropdown values" is named "Page: field" —
 * the page an agent meets it on, then the field it fills — so an operator
 * knows where an edit will show up.
 */
const LISTS = readFileSync(
  resolve(import.meta.dirname, '../src/features/lists/OptionListsPage.tsx'),
  'utf8',
);
const REPLIES = readFileSync(
  resolve(import.meta.dirname, '../src/features/lists/QuickRepliesSection.tsx'),
  'utf8',
);
const EN = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../src/i18n/en.json'), 'utf8'),
) as { lists: { section: Record<string, string> }; replies: { kind: Record<string, string> } };

describe('dropdown values are named "Page: field"', () => {
  it('names every option list after its page', () => {
    for (const label of Object.values(EN.lists.section)) {
      expect(label).toMatch(/^(Tickets|Coupons|Inbox|Late orders): \S/);
    }
    expect(EN.lists.section.lateOrderCause).toBe('Late orders: Source of delay');
  });

  it('names the three ready-wording libraries the same way', () => {
    expect(EN.replies.kind).toMatchObject({
      late_order_reason: 'Late orders: Reason',
      late_order_action: 'Late orders: Action taken',
      chat: 'Inbox: Quick replies',
    });
  });

  /* The section uses its OWN keys: the bare field keys double as captions on
     other screens and must not grow a page prefix there. */
  it('reads the section keys, not the shared field captions', () => {
    expect(LISTS).toMatch(/t\('lists\.section\.issuingSide'/);
    expect(LISTS).not.toMatch(/issuing_side: t\('lists\.issuingSide'/);
    expect(REPLIES).toMatch(/defaultValue: 'Late orders: Reason'/);
  });
});
