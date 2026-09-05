/**
 * The privilege vocabulary now lives in @yiji/shared-types so the agent portal
 * can gate on the same words. This module re-exports it under the path every
 * admin screen already imports, and keeps this portal's own door list.
 */
export {
  PRIVILEGES,
  PRIVILEGE_GROUP,
  ADMIN_PORTAL_PRIVILEGES as PORTAL_PRIVILEGES,
  type Privilege,
  type PrivilegeGroup,
} from '@yiji/shared-types';
