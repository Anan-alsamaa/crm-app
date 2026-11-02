import { useTranslation } from 'react-i18next';
import { EmptyState } from '@yiji/ui';
import { PageHeader, PAGE_BODY } from '../../components/shell/Page.js';

/**
 * The manager's queue: marketing work waits here until a marketing manager
 * approves it (owner, 2026-11-02). Nothing reaches a customer without passing
 * through this page. Items arrive with the coupons step; until then it is
 * empty, and says so.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('approvals.title', { defaultValue: 'Approvals' })}
        description={t('approvals.desc', {
          defaultValue:
            'Marketing coupons, bulk sends and campaigns wait here until a marketing manager approves them. Nothing reaches a customer before that.',
        })}
      />
      <div className={PAGE_BODY}>
        <EmptyState
          title={t('approvals.empty', { defaultValue: 'Nothing is waiting for approval' })}
          description={t('approvals.emptyHint', {
            defaultValue: 'When someone prepares a coupon or a bulk send, it will appear here.',
          })}
        />
      </div>
    </div>
  );
}
