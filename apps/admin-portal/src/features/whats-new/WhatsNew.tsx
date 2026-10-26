import type { JSX, ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { WhatsNewProvider, whatsNewCopy, type WhatsNewLabels } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { ADMIN_PORTAL_WHATS_NEW, WHATS_NEW_VERSION, adminPortalAudience } from './notes.js';

/**
 * The admin portal's "What's new" tour. Mounted inside the signed-in shell
 * only, so it can never appear over the login page; the provider waits for
 * the shell to settle and for any other modal to close.
 */
export function AdminWhatsNew({ children }: { children: ReactNode }): JSX.Element {
  const { t, i18n } = useTranslation();
  const { user, isOwner } = useAuth();
  const locale = i18n?.language ?? 'en';
  const audience = adminPortalAudience(user?.role?.name, isOwner);
  const copy = whatsNewCopy(ADMIN_PORTAL_WHATS_NEW, audience, locale);

  const labels = useMemo<WhatsNewLabels>(
    () => ({
      badge: t('whatsNew.badge', {
        defaultValue: 'New in v{{version}}',
        version: WHATS_NEW_VERSION,
      }),
      step: (current, total) =>
        t('whatsNew.step', { defaultValue: '{{current}} of {{total}}', current, total }),
      next: t('whatsNew.next', { defaultValue: 'Next' }),
      back: t('whatsNew.back', { defaultValue: 'Back' }),
      done: t('whatsNew.done', { defaultValue: 'Let’s go' }),
      close: t('whatsNew.close', { defaultValue: 'Close' }),
      goTo: (n) => t('whatsNew.goTo', { defaultValue: 'Go to slide {{n}}', n }),
    }),
    [t],
  );

  return (
    <WhatsNewProvider
      portal="admin"
      userId={user?.id}
      version={WHATS_NEW_VERSION}
      copy={copy}
      labels={labels}
      dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
    >
      {children}
    </WhatsNewProvider>
  );
}
