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

describe('the language the HOST APP asked for', () => {
  /*
   * The chat opens inside the Yiji app, and the app knows which language the
   * customer picked IN IT. Landing in a different language than the screen
   * they came from reads as a different product — so `?lang=` outranks both
   * the handset and any earlier tap on our own switch.
   *
   * The handset is the weaker signal on purpose: plenty of people run an
   * Arabic app on an English phone, and the app is the one they chose.
   */
  it('beats an English phone', () => {
    navigatorLanguages(['en-US']);
    expect(resolveLocale('?lang=ar')).toBe('ar');
  });

  it('beats an Arabic phone', () => {
    navigatorLanguages(['ar-SA']);
    expect(resolveLocale('?lang=en')).toBe('en');
  });

  it('beats a choice the customer made here on a previous visit', () => {
    // An app that names a language on every open is reporting the customer's
    // CURRENT setting; a tap from last week should not override it.
    storeLocale('en');
    navigatorLanguages(['en-US']);
    expect(resolveLocale('?lang=ar')).toBe('ar');
  });

  it('is not remembered, so a changed app setting is not overridden later', () => {
    // Storing it would let today's value outlive a customer who has since
    // switched the app to the other language.
    resolveLocale('?lang=en');
    expect(localStorage.getItem('yiji.locale')).toBeNull();
  });

  it('accepts the shapes an app actually sends', () => {
    navigatorLanguages(['fr-FR']);
    for (const tag of ['ar', 'AR', 'ar-SA', 'ar_SA', 'ar-sa,en;q=0.9']) {
      expect(resolveLocale(`?lang=${encodeURIComponent(tag)}`)).toBe('ar');
    }
    for (const tag of ['en', 'EN', 'en-US', 'en_GB']) {
      expect(resolveLocale(`?lang=${encodeURIComponent(tag)}`)).toBe('en');
    }
  });

  it('ignores a language it does not recognise instead of guessing', () => {
    // A typo must fall through to the ordinary rules, not pin the customer to
    // whichever language the parser happened to reach for.
    storeLocale('en');
    expect(resolveLocale('?lang=xx')).toBe('en');
    expect(resolveLocale('?lang=')).toBe('en');
  });

  it('falls through to the phone when the app says nothing', () => {
    navigatorLanguages(['en-US']);
    expect(resolveLocale('?token=abc')).toBe('en');
  });

  it('survives a URL that cannot be parsed', () => {
    navigatorLanguages(['ar-SA']);
    expect(resolveLocale('%%%not-a-query')).toBe('ar');
  });
});
