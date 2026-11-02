/**
 * The privilege vocabulary lives in @yiji/shared-types, shared with the other
 * two portals. The Marketing portal's door is its own list: holding a
 * marketing switch opens this portal and nothing else.
 */
export {
  effectivePrivileges,
  MARKETING_PORTAL_PRIVILEGES as PORTAL_PRIVILEGES,
  type Privilege,
} from '@yiji/shared-types';
