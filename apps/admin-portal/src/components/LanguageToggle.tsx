import { useTranslation } from 'react-i18next';

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const next = i18n.language === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next)}
      className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-current/85 transition-colors duration-fast ease-out hover:bg-current/10 hover:text-current"
      aria-label="Toggle language"
    >
      {next === 'ar' ? 'العربية' : 'EN'}
    </button>
  );
}
