/**
 * The privilege vocabulary now lives in @yiji/shared-types so the agent portal
 * can gate on the same words. This module re-exports it under the path every
 * admin screen already imports, and keeps this portal's own door list.
 */
export {
  PRIVILEGES,
  OWNER_PRIVILEGES,
  ALL_PRIVILEGES,
  PRIVILEGE_GROUP,
  PRIVILEGE_PORTAL,
  effectivePrivileges,
  isOwnerPrivilege,
  ADMIN_PORTAL_PRIVILEGES as PORTAL_PRIVILEGES,
  DASHBOARD_PRIVILEGES,
  REPORT_ACCESS_PRIVILEGES,
  type Privilege,
  type PrivilegeGroup,
} from '@yiji/shared-types';
