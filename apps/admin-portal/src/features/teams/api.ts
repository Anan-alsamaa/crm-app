import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

export interface Team {
  id: string;
  name: string;
  description: string | null;
}

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: () =>
      directus.request(
        readItems('teams', { limit: -1, fields: ['id', 'name', 'description'], sort: ['name'] }),
      ) as Promise<Team[]>,
  });
}

export interface CreateTeamInput {
  name: string;
  description?: string;
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTeamInput) => directus.request(createItem('teams', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CreateTeamInput & { id: string }) =>
      directus.request(updateItem('teams', id, input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

/**
 * Deleting a team does NOT delete its people.
 *
 * `directus_users.team` is nulled on delete by the schema, so the agents land
 * back in the unassigned pool the header already counts — visible, and
 * re-assignable. Users are invalidated alongside teams so that count corrects
 * itself immediately rather than after the next navigation.
 */
export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('teams', id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
