import { describe, expect, it } from 'vitest';
import { t, isRtl, type WidgetLocale, type WidgetStrings } from '../src/i18n.js';

describe('i18n: t()', () => {
  it('resolves English strings', () => {
    const en = t('en');
    expect(en.title).toBe('Support');
    expect(en.send).toBe('Send');
    expect(en.poweredBy).toBe('Powered by YIJI CRM');
    expect(en.offlineCallLabel).toBe('Call us');
  });

  it('resolves Arabic strings', () => {
    const ar = t('ar');
    expect(ar.title).toBe('الدعم');
    expect(ar.send).toBe('إرسال');
    expect(ar.poweredBy).toBe('مدعوم بواسطة YIJI CRM');
    expect(ar.offlineCallLabel).toBe('اتصل بنا');
  });

  it('returns a distinct object per locale', () => {
    expect(t('en')).not.toBe(t('ar'));
    expect(t('en').title).not.toBe(t('ar').title);
  });

  it('falls back to English for an unknown locale', () => {
    // Force an invalid locale through the type boundary to exercise the ?? fallback.
    const unknown = t('fr' as unknown as WidgetLocale);
    expect(unknown).toBe(t('en'));
    expect(unknown.title).toBe('Support');
  });

  it('exposes every documented key in both locales with non-empty values', () => {
    const keys: (keyof WidgetStrings)[] = [
      'title',
      'greeting',
      'subtitle',
      'online',
      'placeholder',
      'send',
      'typing',
      'connecting',
      'reconnecting',
      'attach',
      'attachment',
      'attachFailed',
      'removeAttachment',
      'download',
      'close',
      'emptyTitle',
      'emptySub',
      'welcomeNamed',
      'welcomeNew',
      'greetingNamed',
      'poweredBy',
      'csatTitle',
      'csatSub',
      'csatCommentPlaceholder',
      'csatSubmit',
      'csatThanks',
      'csatThanksSub',
      'offlineTitle',
      'offlineBody',
      'offlineCallLabel',
      'offlineWhatsappLabel',
      'offlineEmailLabel',
    ];
    for (const locale of ['en', 'ar'] as WidgetLocale[]) {
      const s = t(locale);
      for (const key of keys) {
        expect(typeof s[key]).toBe('string');
        expect(s[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the {name} placeholder in templated strings for both locales', () => {
    for (const locale of ['en', 'ar'] as WidgetLocale[]) {
      const s = t(locale);
      expect(s.welcomeNamed).toContain('{name}');
      expect(s.greetingNamed).toContain('{name}');
    }
  });
});

describe('i18n: isRtl()', () => {
  it('returns true for Arabic', () => {
    expect(isRtl('ar')).toBe(true);
  });

  it('returns false for English', () => {
    expect(isRtl('en')).toBe(false);
  });
});
