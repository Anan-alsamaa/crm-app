import { useTranslation } from 'react-i18next';
import { EmptyState } from '@yiji/ui';
import { PageHeader, PAGE_BODY } from '../../components/shell/Page.js';

/** A section that is planned and not built yet - said plainly, never a blank page. */
export function ComingNextPage({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={title} description={description} />
      <div className={PAGE_BODY}>
        <EmptyState
          title={t('coming.title', { defaultValue: 'Coming next' })}
          description={t('coming.hint', {
            defaultValue:
              'This part of the Marketing portal is being built. It will appear here when it is ready.',
          })}
        />
      </div>
    </div>
  );
}
