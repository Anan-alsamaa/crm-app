import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { ChartIcon } from '@yiji/ui';
import { ProtectedRoute } from '../../lib/auth/ProtectedRoute.js';
import type { NavItem } from '../../nav.js';

/**
 * REPORTS -> ADMIN KPI (owner, 2026-10-21): the whole system's figures on one
 * page, the CRM's use of Yiji among them. OWNER ONLY - hidden from the nav for
 * everyone else AND closed at the route, so a bookmark is not a back door. Not
 * a privilege: no role edit can hand it out.
 */
export const ADMIN_KPI_PATH = '/reports/admin-kpi';

export function adminKpiNavItem(t: TFunction): NavItem {
  return {
    to: ADMIN_KPI_PATH,
    label: t('nav.adminKpiGroup', { defaultValue: 'Admin KPI' }),
    icon: ChartIcon,
    ownerOnly: true,
  };
}

/** The route's gate: the owner, or the owner-only notice. */
export function AdminKpiGate({ children }: { children: ReactNode }) {
  return <ProtectedRoute ownerOnly>{children}</ProtectedRoute>;
}
