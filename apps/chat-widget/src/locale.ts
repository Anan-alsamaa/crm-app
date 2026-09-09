import type { WidgetLocale } from './i18n.js';

/**
 * Which language to speak to a customer.
 *
 * Order, most authoritative first:
 *
 *   1. What the HOST APP says (`?lang=`). The Yiji app knows which language
 *      the customer chose IN IT, and the chat opens inside that app — landing
 *      in a different language than the screen they came from reads as a
 *      different product. This outranks the handset, which is a weaker signal:
 *      plenty of people run an Arabic app on an English phone, and the app is
 *      the thing they actually chose.
 *   2. A choice they made HERE, on the switch in the corner. Only consulted
 *      when the app said nothing, because an app that names a language on
 *      every open is expressing the customer's current setting, and a
 *      remembered tap from last week should not override it.
 *   3. The phone's own language.
 *   4. ARABIC. The customers are in Saudi Arabia; a phone set to neither
 *      Arabic nor English is a guess either way, and that is the guess that is
 *      right for most people standing in a branch.
 *
 * The switch stays one tap away in both directions, and a tap always wins for
 * the rest of the session — `?lang=` decides where the session STARTS, not
 * what the customer is allowed to read.
 *
 * The choice lives in localStorage so it survives the QR page's handoff to the
 * chat and the next visit; storage that throws (private mode) simply means
 * detection runs again.
 */
const KEY = 'yiji.locale';

export function isLocale(value: unknown): value is WidgetLocale {
  return value === 'ar' || value === 'en';
}

/**
 * The language the host app asked for, from `?lang=`.
 *
 * Deliberately forgiving about the shape: an app may send `ar`, `ar-SA`,
 * `AR`, or the whole `Accept-Language` string it already has to hand. Anything
 * that is not recognisably Arabic or English is ignored rather than guessed
 * at, so a typo falls through to the ordinary rules instead of pinning the
 * customer to the wrong language.
 */
export function localeFromUrl(search: string = window.location.search): WidgetLocale | null {
  try {
    const raw = new URLSearchParams(search).get('lang')?.trim().toLowerCase();
    if (!raw) return null;
    if (raw.startsWith('ar')) return 'ar';
    if (raw.startsWith('en')) return 'en';
    return null;
  } catch {
    return null;
  }
}

export function resolveLocale(search?: string): WidgetLocale {
  /* The app's answer first, and it is not remembered: the app tells us again
     on every open, so storing it would let a stale value outlive a customer
     who has since changed the setting. */
  const fromApp = localeFromUrl(search);
  if (fromApp) return fromApp;

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
