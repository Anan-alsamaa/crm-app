import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { baseI18nOptions, baseResources, DEFAULT_LOCALE, dirFor } from '@yiji/i18n';
import en from './en.json';
import ar from './ar.json';

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('locale') : null;
const initial = stored ?? (navigator.language.startsWith('ar') ? 'ar' : DEFAULT_LOCALE);

void i18n.use(initReactI18next).init({
  ...baseI18nOptions,
  lng: initial,
  resources: {
    en: { ...baseResources.en, admin: en },
    ar: { ...baseResources.ar, admin: ar },
  },
  ns: ['common', 'admin'],
  defaultNS: 'admin',
});

export function applyDocumentDir(locale: string): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = dirFor(locale);
}
applyDocumentDir(i18n.language);
i18n.on('languageChanged', (lng) => {
  applyDocumentDir(lng);
  if (typeof localStorage !== 'undefined') localStorage.setItem('locale', lng);
});

export default i18n;
