import type { InitOptions } from 'i18next';
import enCommon from './locales/en/common.json' with { type: 'json' };
import arCommon from './locales/ar/common.json' with { type: 'json' };

export type SupportedLocale = 'en' | 'ar';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'ar'];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** Locales that render right-to-left. */
export const RTL_LOCALES: SupportedLocale[] = ['ar'];

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.includes(locale as SupportedLocale);
}

/** Document direction for a locale — apply to <html dir>. */
export function dirFor(locale: string): 'rtl' | 'ltr' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

/** Shared base resources (the `common` namespace). Apps merge their own namespaces. */
export const baseResources = {
  en: { common: enCommon },
  ar: { common: arCommon },
} as const;

/**
 * Base i18next options shared across apps. Each app calls
 * i18next.init({ ...baseI18nOptions, resources: mergeResources(...) }).
 */
export const baseI18nOptions: InitOptions = {
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
};
