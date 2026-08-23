/**
 * The privilege vocabulary, in one place.
 *
 * There were two copies of this list and they were about to become three: the
 * Roles page had it as `PRIVS`, the app-roles-sync extension has it as its
 * CATALOG, and nothing on any screen consulted either — every button and every
 * route was visible to anybody the portal let in, and the only real gate was
 * whatever Directus refused to return. That is a fine SECURITY boundary and a
 * poor product: a role with no business editing tickets was still shown Delete,
 * and found out it could not by clicking it.
 *
 * So: the keys live here, the Roles page renders them, and `useAuth().can()`
 * reads them at runtime. The extension's catalog stays the authority on what
 * each one GRANTS in the database — a tick with no catalog entry is stripped
 * server-side, which is what stops the two drifting into lying to each other.
 *
 * None of this is the security boundary. Directus decides what a session may
 * read and write. This decides what a person is OFFERED, which is a different
 * question and the one the screens have to answer.
 */

export const PRIVILEGES = [
  'use_chat',
  'view_all_chats',
  'view_tickets',
  'view_all_tickets',
  'create_tickets',
  'edit_tickets',
  'edit_all_tickets',
  'delete_tickets',
  'approve_coupons',
  'view_dashboard',
  'export_data',
  'import_data',
  'manage_lists',
  'manage_restaurants',
  'manage_users',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

/** Which capability area each privilege belongs to, for the editor's grouping. */
export const PRIVILEGE_GROUP: Record<Privilege, 'chat' | 'tickets' | 'reporting' | 'admin'> = {
  use_chat: 'chat',
  view_all_chats: 'chat',
  view_tickets: 'tickets',
  view_all_tickets: 'tickets',
  create_tickets: 'tickets',
  edit_tickets: 'tickets',
  edit_all_tickets: 'tickets',
  delete_tickets: 'tickets',
  approve_coupons: 'tickets',
  view_dashboard: 'reporting',
  export_data: 'reporting',
  import_data: 'reporting',
  manage_lists: 'admin',
  manage_restaurants: 'admin',
  manage_users: 'admin',
};

/**
 * Privileges that unlock at least one screen in THIS portal.
 *
 * The admin portal used to admit `admin_access` only, which is why an
 * operations lead or an area manager could be given a carefully scoped role
 * and then be told "Administrator access required" at the door. Holding any one
 * of these means there is something in here for you; holding none means there
 * is not, and the login says so instead of implying the password was wrong.
 *
 * `use_chat` is deliberately absent. An agent's place is the agent portal, and
 * a role that can only work the inbox has no business here.
 */
export const PORTAL_PRIVILEGES: readonly Privilege[] = [
  'view_dashboard',
  'view_all_tickets',
  'approve_coupons',
  'manage_lists',
  'manage_restaurants',
  'manage_users',
];
