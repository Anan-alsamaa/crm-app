import type { WidgetLocale } from './i18n.js';

/**
 * Which language to speak to a customer, decided once per page.
 *
 * Order: a choice they made earlier (the switch on either page), then the
 * phone's own language, then ARABIC. The customers are in Saudi Arabia; a
 * phone set to neither Arabic nor English is a guess either way, and the
 * guess that is right for most people standing in a branch is Arabic. The
 * switch is one tap away in both directions and is remembered.
 *
 * The choice lives in localStorage so it survives the QR page's handoff to
 * the chat and the next visit; storage that throws (private mode) simply
 * means detection runs again.
 */
const KEY = 'yiji.locale';

export function isLocale(value: unknown): value is WidgetLocale {
  return value === 'ar' || value === 'en';
}

export function resolveLocale(): WidgetLocale {
  try {
    const stored = localStorage.getItem(KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* no memory, detect instead */
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const tags = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
  for (const tag of tags) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith('ar')) return 'ar';
    if (lower.startsWith('en')) return 'en';
  }
  return 'ar';
}

export function storeLocale(locale: WidgetLocale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    /* the choice holds for this page; the next visit detects again */
  }
}

/** The document's own language and direction, for everything outside the widget. */
export function applyDocumentLocale(locale: WidgetLocale): void {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = locale === 'ar' ? 'rtl' : 'ltr';
}
