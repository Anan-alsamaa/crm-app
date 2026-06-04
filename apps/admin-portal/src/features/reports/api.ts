import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

export type ReportType =
  | 'conversation_volume'
  | 'response_time'
  | 'sla_compliance'
  | 'ticket_resolution'
  | 'agent_productivity'
  | 'csat'
  | 'vendor_activity';

export interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  type: ReportType;
  filters: { from?: string; to?: string; vendor?: string } | null;
  schedule: { email?: string[]; cron?: string } | null;
  last_run_at: string | null;
}

export type ReportInput = Omit<ReportRow, 'id' | 'last_run_at'>;

export function useReports() {
  return useQuery({
    queryKey: ['reports'],
    queryFn: () =>
      directus.request(
        readItems('reports', {
          fields: ['id', 'name', 'description', 'type', 'filters', 'schedule', 'last_run_at'],
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<ReportRow[]>,
  });
}

export function useCreateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReportInput) => directus.request(createItem('reports', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }),
  });
}

export function useUpdateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ReportInput> }) =>
      directus.request(updateItem('reports', id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }),
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('reports', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }),
  });
}
