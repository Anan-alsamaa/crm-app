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
  'wecare supervisor': ['wecare agent', 'wecare supervisor'],
};

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
