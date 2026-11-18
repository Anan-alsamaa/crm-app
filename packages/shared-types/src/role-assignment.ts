/**
 * WHO MAY GIVE WHICH ROLE TO A PERSON (owner, 2026-11-18).
 *
 * "Nada (WeCare Supervisor) should be allowed to create a new user for the
 * role WeCare Agent." The owner's order: WeCare Agent < WeCare Supervisor <
 * WeCare Admin < Administrator.
 *
 * `manage_users` alone used to mean "any role that is not the Administrator's
 * or a service account" at the API, while the Users page could only offer the
 * caller's own role (a role without `manage_roles` could read no other). So a
 * WeCare Supervisor could pick nothing but "WeCare Supervisor" on screen, yet
 * a crafted request could make someone a WeCare Admin.
 *
 * The rule now:
 *  - a role that holds `manage_roles` (WeCare Admin, the Administrator) may
 *    assign any role that is not protected - unchanged;
 *  - a role named below may assign exactly the roles listed for it;
 *  - any other `manage_users` holder may assign only its own role - what its
 *    Users page already offered.
 * Admin-access and `svc-*` roles are never assignable through manage_users,
 * whatever this map says.
 *
 * Keys and values are role names, LOWERCASED (compared case-insensitively).
 *
 * MIRRORED in directus/extensions/app-roles-sync/index.js (a bare Directus
 * hook cannot import this package), which resolves the names to role ids
 * when it materializes a role. `role-assignment-mirror.test.ts` fails the
 * moment the two disagree.
 */
export const ROLE_ASSIGNMENT: Readonly<Record<string, readonly string[]>> = {
  'wecare supervisor': ['wecare agent', 'wecare supervisor'],
};

/**
 * The role names a role may hand out, or `'any'` for "every role that is not
 * protected" (a `manage_roles` holder). Lowercased.
 */
export function assignableRoleNames(
  roleName: string | null | undefined,
  holdsManageRoles: boolean,
): readonly string[] | 'any' {
  if (holdsManageRoles) return 'any';
  const role = String(roleName ?? '')
    .trim()
    .toLowerCase();
  return ROLE_ASSIGNMENT[role] ?? (role ? [role] : []);
}
