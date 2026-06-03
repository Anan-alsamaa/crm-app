import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

export type EntityType = 'contact' | 'conversation' | 'ticket';
export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect';

export interface CustomField {
  id: string;
  entity_type: EntityType;
  name: string;
  key: string;
  field_type: FieldType;
  options: string[] | null;
  required: boolean;
  display_order: number;
}

export type CustomFieldInput = Omit<CustomField, 'id'>;

export function useCustomFields() {
  return useQuery({
    queryKey: ['custom-fields'],
    queryFn: () =>
      directus.request(
        readItems('custom_fields', {
          fields: ['id', 'entity_type', 'name', 'key', 'field_type', 'options', 'required', 'display_order'],
          sort: ['entity_type', 'display_order', 'name'],
          limit: -1,
        }),
      ) as Promise<CustomField[]>,
  });
}

export function useCreateField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomFieldInput) =>
      directus.request(createItem('custom_fields', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields'] }),
  });
}

export function useUpdateField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CustomFieldInput> }) =>
      directus.request(updateItem('custom_fields', id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields'] }),
  });
}

export function useDeleteField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('custom_fields', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields'] }),
  });
}
