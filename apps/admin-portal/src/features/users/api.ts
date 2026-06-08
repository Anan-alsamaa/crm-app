import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readUsers, createUser, updateUser, deleteUser, readRoles } from '@directus/sdk';
import { NotificationType, NotificationChannel } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * Service accounts (svc-socket-gateway, svc-workers, svc-ai-gateway) are how the
 * backend authenticates to Directus — not people. The operations team manages
 * humans only, so we hide anything on an `svc-` role from every user/role list.
 */
const isServiceRole = (name: string | null | undefined): boolean =>
  (name ?? '').toLowerCase().startsWith('svc-');

export interface AdminUser {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  role: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
}

export interface RoleOption {
  id: string;
  name: string;
}

/** Default notification preferences applied to every new user (T037). */
export function defaultNotificationPreferences(): Record<string, string> {
  const channel: string = NotificationChannel.enum.both;
  return Object.fromEntries(NotificationType.options.map((t) => [t, channel]));
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () =>
      directus.request(
        readUsers({
          limit: -1,
          fields: [
            'id',
            'email',
            'first_name',
            'last_name',
            'status',
            { role: ['id', 'name'] },
            { team: ['id', 'name'] },
          ],
          sort: ['email'],
        }),
      ).then((rows) =>
        (rows as AdminUser[]).filter((u) => !isServiceRole(u.role?.name)),
      ) as Promise<AdminUser[]>,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: () =>
      directus
        .request(readRoles({ limit: -1, fields: ['id', 'name'], sort: ['name'] }))
        .then((rows) => (rows as RoleOption[]).filter((r) => !isServiceRole(r.name))) as Promise<
        RoleOption[]
      >,
  });
}

export interface CreateUserInput {
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  role: string;
  team?: string | null;
  locale?: 'en' | 'ar';
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      directus.request(
        createUser({
          ...input,
          team: input.team || null,
          status: 'active',
          notification_preferences: defaultNotificationPreferences(),
        } as never),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export interface UpdateUserPatch {
  first_name?: string | null;
  last_name?: string | null;
  role?: string;
  team?: string | null;
  status?: 'active' | 'inactive';
  locale?: 'en' | 'ar';
  /** Only sent when the admin types a new password. */
  password?: string;
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserPatch }) =>
      directus.request(updateUser(id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteUser(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}
