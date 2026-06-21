import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * RTL layout coverage (Stream C / quality).
 *
 * The language *toggle* is already covered by `language-toggle.test.tsx`, but
 * that suite mocks `react-i18next` so it never exercises the code that actually
 * applies text direction to the document. The real RTL mechanism lives in
 * `src/i18n/index.ts`: an `i18n.on('languageChanged', ...)` listener calls
 * `applyDocumentDir`, which sets `document.documentElement.dir` (and `lang`)
 * via the shared `dirFor` helper. Arabic ('ar') => 'rtl', everything else
 * => 'ltr'.
 *
 * These tests import the REAL i18n instance (no react-i18next mock) so the
 * listener and `applyDocumentDir` run end-to-end, then assert the document
 * direction after switching locales.
 */

// Importing the real module wires the `languageChanged` listener and applies
// the initial direction as a side effect.
import i18n, { applyDocumentDir } from '../src/i18n/index.js';

beforeEach(async () => {
  // Start every test from a known English/LTR baseline.
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  // Leave the shared instance back on the default so suite ordering is stable.
  await i18n.changeLanguage('en');
});

describe('RTL document direction', () => {
  it('applies the initial direction on import', () => {
    // The module calls `applyDocumentDir(i18n.language)` at import time, so the
    // <html> element must carry a concrete direction before any toggle.
    expect(['ltr', 'rtl']).toContain(document.documentElement.dir);
  });

  it('sets dir="rtl" and lang="ar" when switching to Arabic', async () => {
    await i18n.changeLanguage('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('sets dir="ltr" and lang="en" when switching back to English', async () => {
    await i18n.changeLanguage('ar');
    expect(document.documentElement.dir).toBe('rtl');

    await i18n.changeLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('applyDocumentDir applies rtl for ar and ltr for en directly', () => {
    applyDocumentDir('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');

    applyDocumentDir('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });
});
