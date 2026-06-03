import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * Admin vendors API.
 *
 * Vendors are the multi-tenant unit of the system (data, not users). Each
 * vendor has its own branding (logo + colors), support settings, and Yiji
 * ecosystem id used by the commerce panel.
 */

export interface VendorBrandingColors {
  primary?: string;
  secondary?: string;
  // Future: accent, surface, etc.
}

export interface VendorRow {
  id: string;
  name: string;
  yiji_vendor_id: string;
  logo: string | null;
  colors: VendorBrandingColors | null;
  support_settings: Record<string, unknown> | null;
  status: 'active' | 'inactive';
}

export type VendorInput = Pick<VendorRow, 'name' | 'yiji_vendor_id' | 'colors' | 'status'> & {
  logo?: string | null;
};

export function useVendors() {
  return useQuery({
    queryKey: ['vendors'],
    queryFn: () =>
      directus.request(
        readItems('vendors', {
          fields: ['id', 'name', 'yiji_vendor_id', 'logo', 'colors', 'support_settings', 'status'],
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<VendorRow[]>,
  });
}

export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VendorInput) =>
      directus.request(createItem('vendors', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendors'] }),
  });
}

export function useUpdateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<VendorInput> }) =>
      directus.request(updateItem('vendors', id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendors'] }),
  });
}

export function useDeleteVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('vendors', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendors'] }),
  });
}
