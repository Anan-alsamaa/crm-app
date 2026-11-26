/**
 * WHICH ROLES A USER MANAGER MAY HAND OUT (owner, 18 Nov 2026).
 *
 * "Nada (WeCare Supervisor) should be allowed to create a new user for the
 * role WeCare Agent." The owner's order is WeCare Agent < WeCare Supervisor <
 * WeCare Admin < Administrator (the master user).
 *
 * A role that holds `manage_roles` (WeCare Admin, Department Manager, the
 * Administrator) keeps what it has always had: any role that is not protected
 * (admin-access and service roles never are). A role that manages users WITHOUT
 * managing roles may assign only the roles named here - before this, the Users
 * page could only offer its own role (it could not read the role list), while
 * the database would have accepted ANY unprotected role through the API.
 *
 * Names are compared lowercased. A user-managing role not listed here may
 * assign only its own role, which is exactly what its Users page offered.
 *
 * Mirrored in directus/extensions/app-roles-sync/index.js (plain JS, cannot
 * import this); `role-assignment.test.ts` fails if the two disagree.
 */
export const ROLE_ASSIGNABLE_ROLES: Readonly<Record<string, readonly string[]>> = {
  /* WeCare Agent ONLY (owner, 26 Nov 2026): on 25 Nov a supervisor promoted an
     agent to WeCare Supervisor. Giving the Supervisor role is WeCare Admin's
     and the Administrator's. */
  'wecare supervisor': ['wecare agent'],
};

/**
 * A PER-PERSON BLOCK ON MANAGING USERS (owner, 26 Nov 2026): the Administrator
 * can stop one person creating, editing or deleting users until a date,
 * without touching their role (which colleagues share). Active while `until`
 * is in the future; it lifts by itself. Mirrored in app-roles-sync, which
 * enforces it on the server.
 */
export function isUserAdminBlocked(
  until: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * The role names `roleName` may assign, lowercased - or `null` when it is not
 * fenced (it holds `manage_roles`, or does not manage users at all).
 */
export function assignableRoleNames(
  roleName: string | null | undefined,
  privileges: Record<string, boolean> | null | undefined,
): string[] | null {
  const p = privileges ?? {};
  if (p.manage_users !== true || p.manage_roles === true) return null;
  const role = String(roleName ?? '')
    .trim()
    .toLowerCase();
  if (!role) return [];
  return [...(ROLE_ASSIGNABLE_ROLES[role] ?? [role])];
}
