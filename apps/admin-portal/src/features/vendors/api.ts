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

/**
 * Non-secret customer-push settings (MV-1). Same names as the connector's
 * `YijiPlatformSettings.push`; the API key is a SECRET and is never here.
 */
export interface VendorNotifySettings {
  notifyUrl?: string;
  notifyTopic?: string;
  notifyTitle?: string;
  openChatAction?: string;
}

/**
 * The vendor's NON-SECRET integration settings (MV-1, EMA-70). Credentials
 * stay in service configuration until MV-3 decides how secrets are stored.
 * All optional: a vendor row from before MV-1 has none of them.
 */
export interface VendorIntegration {
  platform?: 'yiji' | null;
  api_base_url?: string | null;
  admin_api_url?: string | null;
  tenant_id?: string | null;
  brand_id?: string | null;
  notify_settings?: VendorNotifySettings | null;
  webhook_path_key?: string | null;
}

export interface VendorRow extends VendorIntegration {
  id: string;
  name: string;
  yiji_vendor_id: string;
  logo: string | null;
  colors: VendorBrandingColors | null;
  support_settings: Record<string, unknown> | null;
  status: 'active' | 'inactive';
}

export type VendorInput = Pick<VendorRow, 'name' | 'yiji_vendor_id' | 'colors' | 'status'> &
  VendorIntegration & {
    logo?: string | null;
  };

/** Every integration field, for the read and the form. */
export const VENDOR_INTEGRATION_FIELDS = [
  'platform',
  'api_base_url',
  'admin_api_url',
  'tenant_id',
  'brand_id',
  'notify_settings',
  'webhook_path_key',
] as const;

/**
 * Vendors with DISPLAY fields only, for every page that is not the owner-only
 * Vendors page. Since MV-5 a non-Administrator may read only these fields, and
 * Directus refuses a whole query that names one more - so the late-orders
 * report (WeCare Admin) must not borrow the Vendors page's full read.
 */
export function useVendorDirectory() {
  return useQuery({
    queryKey: ['vendors', 'display'],
    queryFn: () =>
      directus.request(
        readItems('vendors', {
          fields: ['id', 'name', 'yiji_vendor_id', 'status'],
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<Array<Pick<VendorRow, 'id' | 'name' | 'yiji_vendor_id' | 'status'>>>,
  });
}

/** Owner-only: every field, including integration settings (Vendors page). */
export function useVendors() {
  return useQuery({
    queryKey: ['vendors'],
    queryFn: () =>
      directus.request(
        readItems('vendors', {
          fields: [
            'id',
            'name',
            'yiji_vendor_id',
            'logo',
            'colors',
            'support_settings',
            'status',
            ...VENDOR_INTEGRATION_FIELDS,
          ],
          sort: ['name'],
          limit: -1,
        }),
      ) as Promise<VendorRow[]>,
  });
}

export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VendorInput) => directus.request(createItem('vendors', input as never)),
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

/**
 * WHICH VENDOR EACH BRAND / STORE BELONGS TO (MV-1), for the read-only Vendor
 * column on those pages.
 *
 * Its OWN query on purpose, not a field added to `useStores`: that query also
 * feeds the store index every report and the coupon queue attribute orders
 * with, and Directus 403s a WHOLE query that names a missing field. Kept
 * apart, a vendor column that cannot load shows a dash and nothing else
 * notices. NULL (pre-MV-1, not yet backfilled) also shows a dash.
 */
export function useRecordVendorNames(collection: 'brands' | 'stores') {
  return useQuery({
    queryKey: ['record-vendor-names', collection],
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(collection, { limit: -1, fields: ['id', 'vendor.name'] as never }),
      )) as Array<{ id: string; vendor?: { name?: string | null } | null }>;
      return new Map(rows.map((r) => [r.id, r.vendor?.name ?? null]));
    },
  });
}
