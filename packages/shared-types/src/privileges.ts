/**
 * The privilege vocabulary — ONE list, read by both portals.
 *
 * It lived in the admin portal alone, and the agent portal had no gating at
 * all: every signed-in user saw every page. Moving it here is what lets the
 * agent portal decide what to offer from the same words the Roles page uses
 * to describe a role, so the two cannot drift.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Vendors, AI settings, and the ceiling of the roles editor are not
 * privileges. They are gated on Directus `admin_access` — the project owner —
 * and there is no key anyone can tick to hand them out. That is the design:
 * a role may be given everything on this list and still be unable to reach
 * the things that only the owner holds, and no edit to any role can change
 * that, because the capability does not exist as a grantable thing.
 *
 * THE OWNER-ONLY INVENTORY (2026-09-05), so the boundary is one list:
 *
 *   in this app     Vendors; AI settings; editing the Administrator's own
 *                   account; assigning any admin_access or service role;
 *                   the ceiling override in the Roles editor.
 *   in AWS          The ECS task definitions — which carry the Yiji
 *                   credentials and the coupon delivery switch
 *                   (YIJI_COUPON_DELIVERY). Writable only by the owner's IAM
 *                   user.
 *   in GitHub       Production deploys — the `prod` environment requires the
 *                   owner's review before any workflow may run against it.
 *
 * Anything new that moves money, data or credentials belongs on this list,
 * gated with `ownerOnly` — not with a privilege.
 *
 * The extension's CATALOG stays the authority on what each key GRANTS in the
 * database — a tick with no catalog entry is stripped server-side. None of
 * this is the security boundary; Directus is. This decides what a person is
 * OFFERED.
 */

export const PRIVILEGES = [
  // ── chat ────────────────────────────────────────────────────────────────
  'use_chat',
  'view_all_chats',
  // ── tickets ─────────────────────────────────────────────────────────────
  'view_tickets',
  'view_all_tickets',
  'create_tickets',
  'edit_tickets',
  'edit_all_tickets',
  'delete_tickets',
  'approve_coupons',
  // ── reporting ───────────────────────────────────────────────────────────
  'view_dashboard',
  /**
   * The OPERATIONS view of the dashboard — branch, brand and area-manager
   * cuts. Split from `view_dashboard` because the operations team is not
   * meant to see the agent desk, and the desk is not meant to see the
   * operations board unless told.
   */
  'view_ops_dashboard',
  'export_data',
  'import_data',
  /** Create and edit scheduled report deliveries. */
  'schedule_reports',
  // ── administration ──────────────────────────────────────────────────────
  /** Dropdown lists and app settings only — SLA, AI and reports are their own. */
  'manage_lists',
  'manage_restaurants',
  'manage_users',
  /** SLA policies. Was under `manage_lists`, which also opened AI and reports. */
  'manage_sla',
  /**
   * The Roles & privileges editor. Holding it does NOT let you grant what you
   * do not hold: the editor and the server both apply a ceiling. See the
   * app-roles-sync extension.
   */
  'manage_roles',
  /** The self-serve JSON backup. Read grants come from the other privileges. */
  'manage_backup',
  /**
   * Signals that this role is EXPECTED to use the Directus admin app directly,
   * and grants the reads that make it usable (the schema, so the collection
   * list renders with real field names rather than raw keys).
   *
   * It does NOT grant `admin_access` — nothing in this list can. A holder sees
   * the collections their other privileges already allow, and is refused on
   * permissions, policies and roles exactly as before. The point is a manager
   * with the run of the data who still cannot re-draw who may see what.
   */
  'use_directus_app',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

export type PrivilegeGroup = 'chat' | 'tickets' | 'reporting' | 'admin';

/** Which capability area each privilege belongs to, for the editor's grouping. */
export const PRIVILEGE_GROUP: Record<Privilege, PrivilegeGroup> = {
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
  view_ops_dashboard: 'reporting',
  export_data: 'reporting',
  import_data: 'reporting',
  schedule_reports: 'reporting',
  manage_lists: 'admin',
  manage_restaurants: 'admin',
  manage_users: 'admin',
  manage_sla: 'admin',
  manage_roles: 'admin',
  manage_backup: 'admin',
  use_directus_app: 'admin',
};

/**
 * Privileges that unlock at least one screen in the ADMIN portal.
 *
 * Holding any one means there is something in there for you; holding none
 * means there is not, and the login says so instead of implying the password
 * was wrong. `use_chat` is deliberately absent: an agent's place is the agent
 * portal.
 */
export const ADMIN_PORTAL_PRIVILEGES: readonly Privilege[] = [
  'view_dashboard',
  'view_ops_dashboard',
  'view_all_tickets',
  'view_all_chats',
  'approve_coupons',
  'schedule_reports',
  'manage_lists',
  'manage_restaurants',
  'manage_users',
  'manage_sla',
  'manage_roles',
  'manage_backup',
  'use_directus_app',
];

/**
 * Privileges that unlock at least one screen in the AGENT portal.
 *
 * An operations user holds none of these and is refused at the door, the way
 * an agent is refused at the admin portal's.
 */
export const AGENT_PORTAL_PRIVILEGES: readonly Privilege[] = [
  'use_chat',
  'view_tickets',
  'create_tickets',
];

/** True when `privileges` opens at least one screen in the given portal. */
export function opensPortal(
  privileges: Record<string, boolean> | null | undefined,
  portal: 'admin' | 'agent',
): boolean {
  const list = portal === 'admin' ? ADMIN_PORTAL_PRIVILEGES : AGENT_PORTAL_PRIVILEGES;
  return list.some((p) => privileges?.[p] === true);
}
