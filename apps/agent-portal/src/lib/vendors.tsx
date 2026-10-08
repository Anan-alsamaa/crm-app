import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { Pill, cn } from '@yiji/ui';
import { activeVendorsOf, showVendorUi, vendorIdOf, type VendorRef } from '@yiji/shared-types';
import { directus } from './directus.js';

/**
 * WHICH VENDOR A CHAT, TICKET OR COUPON BELONGS TO — shown only when it is a
 * question (MV-4, EMA-73).
 *
 * The same agents serve every vendor, so with two or more vendors live an agent
 * has to see whose customer they are answering. With ONE vendor (today) every
 * badge would name the only possible answer and every filter would offer one
 * choice, so the whole vendor UI stays invisible: `show` is false, `nameOf`
 * still answers, and nothing renders.
 */
export interface VendorOption {
  id: string;
  name: string;
  /** The vendor's id on its commerce platform — what the gateway's endpoints take. */
  platformId: string | null;
}

export interface VendorDirectory {
  /** True when 2+ vendors are active — the only time vendor UI appears. */
  show: boolean;
  /** The ACTIVE vendors, for a filter. */
  options: VendorOption[];
  /** The vendor's display name (any status), or null when unknown. */
  nameOf: (ref: VendorRef) => string | null;
}

interface VendorRow {
  id: string;
  name: string | null;
  status?: string | null;
  yiji_vendor_id?: string | null;
}

export function useVendorDirectory(): VendorDirectory {
  const q = useQuery({
    queryKey: ['vendor-directory'],
    // Vendors change when the Administrator adds one, which is rare.
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        /* Display fields only — every non-Administrator read of `vendors` is
           limited to id/name/logo/colors/status/yiji_vendor_id (MV-5). */
        return (await directus.request(
          readItems('vendors', {
            fields: ['id', 'name', 'status', 'yiji_vendor_id'],
            limit: -1,
          }),
        )) as VendorRow[];
      } catch {
        // Cannot tell how many vendors exist: behave as one vendor (no UI).
        return [] as VendorRow[];
      }
    },
  });
  return useMemo(() => {
    const rows = q.data ?? [];
    const names = new Map(rows.map((v) => [v.id, v.name ?? v.id]));
    return {
      show: showVendorUi(rows),
      options: activeVendorsOf(rows)
        .map((v) => ({
          id: v.id,
          name: v.name ?? v.id,
          platformId: v.yiji_vendor_id?.trim() || null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      nameOf: (ref: VendorRef) => {
        const id = vendorIdOf(ref);
        if (!id) return null;
        /* An expanded relation may already carry the name. */
        const inline =
          ref && typeof ref === 'object' ? (ref as { name?: string | null }).name : null;
        return inline ?? names.get(id) ?? null;
      },
    };
  }, [q.data]);
}

/**
 * The record's vendor as a small badge — renders NOTHING with a single vendor,
 * or when the record's vendor is unknown.
 */
export function VendorBadge({
  vendor,
  directory,
  className,
}: {
  vendor: VendorRef;
  directory: VendorDirectory;
  className?: string;
}) {
  if (!directory.show) return null;
  const name = directory.nameOf(vendor);
  if (!name) return null;
  return (
    <Pill
      tone="purple"
      size="sm"
      className={cn('shrink-0', className)}
      data-testid="vendor-badge"
      title={name}
    >
      {name}
    </Pill>
  );
}

/**
 * Which vendor each row of a collection belongs to, read ONLY when the vendor
 * UI is shown.
 *
 * Its own query on purpose (the MV-1 lesson): Directus 403s a WHOLE query that
 * names a missing field, and `coupon_approvals.vendor` is an MV-1 column — so it
 * is never added to the queue's own read, where a missing column would empty
 * the coupon list. Disabled with one vendor, so today it never runs.
 */
export function useRecordVendorIds(collection: 'coupon_approvals', enabled: boolean) {
  return useQuery({
    queryKey: ['record-vendor-ids', collection],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(collection as never, { fields: ['id', 'vendor'], limit: -1 } as never),
      )) as unknown as Array<{ id: string; vendor?: VendorRef }>;
      return new Map(rows.map((r) => [r.id, vendorIdOf(r.vendor)]));
    },
  });
}
