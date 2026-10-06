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

/**
 * THE FINE-GRAINED PERMISSIONS — shown to the ADMINISTRATOR ONLY (owner,
 * 2026-10-06).
 *
 * Every action that used to be decided by a hard-coded role NAME, by "owner
 * only", or by riding along with a broader privilege, as its own switch — so
 * the owner can hand out "view all", "delete", "export"… per page without a
 * developer. Everybody else who can open the Roles page (a WeCare Admin) keeps
 * seeing exactly the list above and nothing of these.
 *
 * NONE OF THEM NEEDS TO BE STORED TO WORK. A role that has never had one ticked
 * gets its DEFAULT (`OWNER_PRIVILEGE_DEFAULTS`), which reproduces precisely what
 * that role could do before these existed — so shipping this changes nothing
 * for anyone until the owner flips a switch. A stored true/false always wins.
 */
export const OWNER_PRIVILEGES = [
  // ── chat ────────────────────────────────────────────────────────────────
  'start_chats',
  'assign_chats',
  'close_chats',
  'bulk_edit_chats',
  'delete_chats',
  'edit_own_messages',
  'receive_chats',
  'no_agents_alert',
  // ── customers ───────────────────────────────────────────────────────────
  'view_contacts',
  'create_contacts',
  'edit_contacts',
  'export_contacts',
  // ── tickets ─────────────────────────────────────────────────────────────
  'view_ticket_history',
  'export_ticket_excel',
  // ── late orders ─────────────────────────────────────────────────────────
  'work_late_orders',
  'view_late_orders_report',
  'export_late_orders',
  'view_order_details',
  // ── coupons ─────────────────────────────────────────────────────────────
  'request_coupons',
  'view_coupon_spend',
  'view_compensation_reports',
  'delete_compensation',
  // ── reporting ───────────────────────────────────────────────────────────
  'view_agent_reports',
  'view_sla_report',
  // ── administration ──────────────────────────────────────────────────────
  'delete_users',
  'manage_teams',
  'edit_yiji_branch_id',
  'manage_store_notifications',
  'manage_notification_defaults',
] as const;

export type OwnerPrivilege = (typeof OWNER_PRIVILEGES)[number];
export type Privilege = (typeof PRIVILEGES)[number] | OwnerPrivilege;

/** Every key, in editor order: the shared list, then the owner's. */
export const ALL_PRIVILEGES: readonly Privilege[] = [...PRIVILEGES, ...OWNER_PRIVILEGES];

export function isOwnerPrivilege(key: string): key is OwnerPrivilege {
  return (OWNER_PRIVILEGES as readonly string[]).includes(key);
}

const nameIn =
  (...names: string[]) =>
  (_p: Record<string, boolean>, role: string) =>
    names.includes(role);
const holds = (key: string) => (p: Record<string, boolean>) => p[key] === true;
const never = () => false;

/**
 * What each fine-grained permission is WHEN NOTHING IS STORED: exactly the
 * rule the code applied before it existed. Role names are compared lowercased.
 *
 * Mirrored in directus/extensions/app-roles-sync/index.js (plain JS, cannot
 * import this); `privileges-mirror.test.ts` fails if the two disagree.
 */
export const OWNER_PRIVILEGE_DEFAULTS: Record<
  OwnerPrivilege,
  (p: Record<string, boolean>, role: string) => boolean
> = {
  // The gateway's CHAT_INITIATE_ROLES.
  start_chats: nameIn(
    'administrator',
    'admin',
    'agent',
    'wecare agent',
    'wecare supervisor',
    'wecare admin',
  ),
  // edit_all_tickets carried the whole conversation update before 2026-10-06.
  assign_chats: (p) => p.use_chat === true || p.edit_all_tickets === true,
  close_chats: (p) => p.use_chat === true || p.edit_all_tickets === true,
  bulk_edit_chats: holds('use_chat'),
  delete_chats: never, // was the Administrator only
  edit_own_messages: holds('use_chat'),
  // The gateway's PRESENCE_ROLES / the workers' ROUTABLE_ROLES.
  receive_chats: nameIn('wecare agent', 'wecare supervisor'),
  // The workers' SUPERVISOR_ROLES.
  no_agents_alert: nameIn('wecare supervisor', 'wecare admin', 'administrator'),
  view_contacts: holds('use_chat'),
  create_contacts: holds('use_chat'),
  edit_contacts: holds('use_chat'),
  export_contacts: holds('use_chat'),
  // The agent portal's history-visibility list.
  view_ticket_history: nameIn('administrator', 'admin', 'wecare admin', 'wecare supervisor'),
  export_ticket_excel: nameIn('administrator', 'admin'),
  work_late_orders: holds('create_tickets'),
  view_late_orders_report: (p) => p.view_all_tickets === true && p.view_all_chats === true,
  export_late_orders: nameIn('wecare admin', 'wecare supervisor'),
  view_order_details: (_p, role) => role.startsWith('wecare'),
  request_coupons: holds('create_tickets'),
  view_coupon_spend: nameIn('administrator', 'wecare admin', 'wecare supervisor'),
  view_compensation_reports: holds('approve_coupons'),
  delete_compensation: never, // no role could (the grant never existed)
  view_agent_reports: holds('view_all_chats'),
  view_sla_report: (p) => p.view_all_tickets === true && p.view_all_chats === true,
  delete_users: nameIn('administrator', 'wecare admin'),
  manage_teams: holds('manage_users'),
  edit_yiji_branch_id: never, // was the Administrator only
  manage_store_notifications: holds('manage_restaurants'),
  manage_notification_defaults: never, // was the Administrator only
};

/**
 * The privileges a role ACTUALLY has: what is stored, plus the default of every
 * fine-grained permission that is not. The one function every reader uses —
 * both portals, the gateway, the workers — so "what can this role do" has one
 * answer.
 */
export function effectivePrivileges(
  stored: Record<string, boolean> | null | undefined,
  roleName: string | null | undefined,
): Record<string, boolean> {
  const p: Record<string, boolean> = { ...(stored ?? {}) };
  const role = String(roleName ?? '')
    .trim()
    .toLowerCase();
  for (const key of OWNER_PRIVILEGES) {
    if (typeof p[key] !== 'boolean') p[key] = OWNER_PRIVILEGE_DEFAULTS[key](p, role);
  }
  return p;
}

export type PrivilegeGroup =
  | 'chat'
  | 'customers'
  | 'tickets'
  | 'lateOrders'
  | 'coupons'
  | 'reporting'
  | 'admin';

/** Which capability area each privilege belongs to, for the editor's grouping. */
export const PRIVILEGE_GROUP: Record<Privilege, PrivilegeGroup> = {
  start_chats: 'chat',
  assign_chats: 'chat',
  close_chats: 'chat',
  bulk_edit_chats: 'chat',
  delete_chats: 'chat',
  edit_own_messages: 'chat',
  receive_chats: 'chat',
  no_agents_alert: 'chat',
  view_contacts: 'customers',
  create_contacts: 'customers',
  edit_contacts: 'customers',
  export_contacts: 'customers',
  view_ticket_history: 'tickets',
  export_ticket_excel: 'tickets',
  work_late_orders: 'lateOrders',
  view_late_orders_report: 'lateOrders',
  export_late_orders: 'lateOrders',
  view_order_details: 'lateOrders',
  request_coupons: 'coupons',
  view_compensation_reports: 'coupons',
  view_coupon_spend: 'coupons',
  delete_compensation: 'coupons',
  view_agent_reports: 'reporting',
  view_sla_report: 'reporting',
  delete_users: 'admin',
  manage_teams: 'admin',
  edit_yiji_branch_id: 'admin',
  manage_store_notifications: 'admin',
  manage_notification_defaults: 'admin',
  use_chat: 'chat',
  view_all_chats: 'chat',
  view_tickets: 'tickets',
  view_all_tickets: 'tickets',
  create_tickets: 'tickets',
  edit_tickets: 'tickets',
  edit_all_tickets: 'tickets',
  delete_tickets: 'tickets',
  approve_coupons: 'tickets', // where everyone else has always found it
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

/**
 * The Directus role NAMES whose role holds `key` — for the services that pick
 * people by role (who is routed chats, who is alerted). `roleNames` is every
 * Directus role; a role with no app_roles row is judged on its defaults alone,
 * which is how the Administrator keeps the alerts it always had.
 */
export function roleNamesHolding(
  key: Privilege,
  roleNames: readonly string[],
  appRoles: ReadonlyArray<{ name: string; privileges: unknown }>,
): string[] {
  const byName = new Map(appRoles.map((r) => [r.name.trim().toLowerCase(), r.privileges]));
  return roleNames.filter((name) => {
    const raw = byName.get(name.trim().toLowerCase());
    const stored = typeof raw === 'string' ? safeJson(raw) : raw;
    return effectivePrivileges(stored as Record<string, boolean> | null, name)[key] === true;
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** True when `privileges` opens at least one screen in the given portal. */
export function opensPortal(
  privileges: Record<string, boolean> | null | undefined,
  portal: 'admin' | 'agent',
): boolean {
  const list = portal === 'admin' ? ADMIN_PORTAL_PRIVILEGES : AGENT_PORTAL_PRIVILEGES;
  return list.some((p) => privileges?.[p] === true);
}
