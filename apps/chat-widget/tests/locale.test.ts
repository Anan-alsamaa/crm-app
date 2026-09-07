import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentLocale, isLocale, resolveLocale, storeLocale } from '../src/locale.js';

/** Pretend the phone reports these languages, in order of preference. */
function navigatorLanguages(languages: string[]): void {
  vi.stubGlobal('navigator', { languages, language: languages[0] });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

describe('which language a customer is greeted in', () => {
  it('defaults to ARABIC when the phone says nothing either way', () => {
    /*
     * The customers are in Saudi Arabia. A phone set to French tells us the
     * visitor reads neither of our languages, and between two guesses the one
     * that is right for most people standing in a branch is Arabic. English
     * used to be hardcoded, which was a guess too — just the wrong one.
     */
    navigatorLanguages(['fr-FR']);
    expect(resolveLocale()).toBe('ar');
  });

  it('defaults to Arabic when the browser reports no languages at all', () => {
    vi.stubGlobal('navigator', {});
    expect(resolveLocale()).toBe('ar');
  });

  it('follows the phone when it asks for English', () => {
    navigatorLanguages(['en-GB']);
    expect(resolveLocale()).toBe('en');
  });

  it('follows the phone when it asks for Arabic', () => {
    navigatorLanguages(['ar-SA']);
    expect(resolveLocale()).toBe('ar');
  });

  it('takes the FIRST language it understands, not the first listed', () => {
    // A phone set to French with English second reads English, not the default.
    navigatorLanguages(['fr-FR', 'en-US', 'ar']);
    expect(resolveLocale()).toBe('en');
  });

  it('lets an earlier choice beat the phone, in both directions', () => {
    navigatorLanguages(['ar-SA']);
    storeLocale('en');
    expect(resolveLocale()).toBe('en');
    storeLocale('ar');
    navigatorLanguages(['en-US']);
    expect(resolveLocale()).toBe('ar');
  });

  it('ignores a stored value that is not a language we speak', () => {
    localStorage.setItem('yiji.locale', 'fr');
    navigatorLanguages(['en-US']);
    expect(resolveLocale()).toBe('en');
  });

  it('detects again when storage throws, rather than failing to open', () => {
    // Private mode: the accessor itself throws on some browsers.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    navigatorLanguages(['en-US']);
    expect(() => storeLocale('ar')).not.toThrow();
    expect(resolveLocale()).toBe('en');
  });
});

describe('the page itself follows the language', () => {
  it('sets lang and direction for Arabic', () => {
    // Everything outside the widget — the QR form, the backdrop — is laid out
    // by the document's own dir, not the widget's.
    applyDocumentLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('sets lang and direction for English', () => {
    applyDocumentLocale('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('isLocale', () => {
  it('accepts the two languages and nothing else', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
