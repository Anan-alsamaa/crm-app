import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readUsers, createUser, readRoles } from '@directus/sdk';
import { NotificationType, NotificationChannel } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

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
      ) as Promise<AdminUser[]>,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: () =>
      directus.request(readRoles({ limit: -1, fields: ['id', 'name'], sort: ['name'] })) as Promise<
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
