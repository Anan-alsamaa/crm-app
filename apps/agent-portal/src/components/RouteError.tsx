import { useTranslation } from 'react-i18next';
import { Button } from '@yiji/ui';

/** Fallback rendered by the route-level ErrorBoundary when a page throws. */
export function RouteError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-5 px-6 py-16 text-center"
    >
      <div
        aria-hidden
        className="grid h-14 w-14 place-items-center rounded-2xl bg-destructive/10 text-destructive"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-7 w-7"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {t('errors.pageTitle', { ns: 'common' })}
        </h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          {t('errors.pageBody', { ns: 'common' })}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" onClick={onRetry}>
          {t('errors.retry', { ns: 'common' })}
        </Button>
        <Button type="button" variant="ghost" onClick={() => window.location.reload()}>
          {t('errors.reload', { ns: 'common' })}
        </Button>
      </div>
    </div>
  );
}
