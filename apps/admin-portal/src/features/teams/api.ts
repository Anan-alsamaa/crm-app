import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem } from '@directus/sdk';
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
