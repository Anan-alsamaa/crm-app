import { useTranslation } from 'react-i18next';

export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const next = i18n.language === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next)}
      className="inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2.5 text-xs font-semibold text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground"
      aria-label={t('actions.toggleLanguage', { ns: 'common', defaultValue: 'Toggle language' })}
    >
      {next === 'ar' ? 'العربية' : 'EN'}
    </button>
  );
}
