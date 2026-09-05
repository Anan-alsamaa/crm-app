import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EmptyState, Spinner } from '@yiji/ui';
import type { Privilege } from '@yiji/shared-types';
import { useAuth } from './AuthContext.js';

/**
 * Gate a route: signed in, admitted to this portal, and — optionally — holding
 * the privilege the page needs.
 *
 * This used to admit by ROLE NAME (Agent, Admin, Administrator), which meant
 * every person on one of those roles saw every page, and a role built for
 * operations could not be kept out at all. It now reads the same privileges
 * the Roles page describes, so "agent: inbox, tickets, add ticket, performance,
 * compensation" is a fact about the role rather than a hope about the name.
 *
 * None of this is the security boundary; Directus is. A role that reaches a
 * page it should not gets an empty screen rather than data.
 */
export function ProtectedRoute({
  children,
  requires,
}: {
  children: ReactNode;
  requires?: Privilege;
}) {
  const { t } = useTranslation();
  const { user, loading, canUsePortal, can } = useAuth();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  if (!canUsePortal) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title={t('auth.noPortalAccess', { defaultValue: 'This portal is not for your role' })}
          description={t('auth.noPortalAccessHint', {
            defaultValue:
              'Your account is signed in, but none of the screens here are open to it. If you run reports or manage the operation, use the admin portal instead.',
          })}
        />
      </div>
    );
  }

  if (requires && !can(requires)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title={t('auth.noPagePrivilege', { defaultValue: 'You do not have access to this page' })}
          description={t('auth.noPagePrivilegeHint', {
            defaultValue:
              'Your role does not include this. An administrator can change that under Roles & privileges.',
          })}
        />
      </div>
    );
  }

  return <>{children}</>;
}
