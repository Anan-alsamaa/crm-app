import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE ADD-TICKET PAGE SCROLLS AS A PAGE (owner, 2026-10-25), not card by card.
 *
 * jsdom has no layout, so this is asserted on the classes: the page wrapper is
 * the one scroll container, and nothing inside the form scrolls or clips.
 */
const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
const PAGE = read('../src/features/tickets/NewTicketPage.tsx');
const FORM = read('../src/features/tickets/CreateTicketDialog.tsx');

describe('Add ticket page scroll', () => {
  it('the page wrapper is the one scroll container', () => {
    expect(PAGE).toMatch(/<div className="h-full min-h-0 overflow-y-auto">/);
  });

  it('no inner scroll containers or clipping inside the form', () => {
    expect(FORM).not.toMatch(/overflow-y-auto/);
    expect(FORM).not.toMatch(/lg:overflow-hidden/);
    expect(FORM).toMatch(/className="flex min-h-full flex-col bg-background"/);
  });

  it('the header with Create stays reachable while the page scrolls', () => {
    expect(FORM).toMatch(/className="sticky top-0 z-20 flex flex-wrap items-center/);
  });

  it('never shows the "Draft restored" strip', () => {
    expect(FORM).not.toMatch(/tickets\.draftRestored/);
  });
});
