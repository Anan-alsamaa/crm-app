import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { readItems } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { SelectMenu } from '@yiji/ui';
import { activeVendorsOf, showVendorUi } from '@yiji/shared-types';
import { directus } from './directus.js';

/**
 * THE REPORTS' VENDOR FILTER (MV-4, EMA-73).
 *
 * One choice shared by every report page and the dashboard — narrowing to a
 * vendor on the SLA report and then opening the ticket breakdown should not
 * silently widen back to every vendor. Kept for the tab's session.
 *
 * Offered ONLY when 2+ vendors are active. With one vendor (today) the control
 * does not render, no choice can be made, and `useReportVendorFilter` answers
 * '' — so every report query is exactly what it was before, with not even an
 * extra request: the vendor list is read by the CONTROL, and by a report only
 * while a choice is actually set (to check it still names an active vendor; a
 * choice left over from when a second vendor was live must stop applying the
 * moment it is gone, never silently empty a report).
 *
 * Plain module state rather than React Query, so it works under any provider
 * tree (and adds nothing to a report's own request count).
 */

const STORAGE_KEY = 'sara.reports.vendor';
const VENDORS_TTL_MS = 5 * 60_000;

interface VendorRow {
  id: string;
  name: string | null;
  status?: string | null;
}

let choice = ((): string => {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
})();
let vendors: VendorRow[] | null = null;
let vendorsAt = 0;
let pending: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function setChoice(next: string): void {
  if (next === choice) return;
  choice = next;
  try {
    if (next) sessionStorage.setItem(STORAGE_KEY, next);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked — the choice still holds for this page's life */
  }
  emit();
}

function loadVendors(): void {
  if (pending || (vendors && Date.now() - vendorsAt < VENDORS_TTL_MS)) return;
  pending = (async () => {
    try {
      /* Display fields only — what every non-Administrator may read (MV-5). */
      vendors = (await directus.request(
        readItems('vendors', { fields: ['id', 'name', 'status'], limit: -1 }),
      )) as VendorRow[];
    } catch {
      // Cannot tell how many vendors exist: behave as one vendor (no filter).
      vendors = [];
    }
    if (!Array.isArray(vendors)) vendors = [];
    vendorsAt = Date.now();
    pending = null;
    emit();
  })();
}

function useStore(load: boolean): { choice: string; vendors: VendorRow[] | null } {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (load) loadVendors();
  }, [load]);
  return { choice, vendors };
}

function validChoice(c: string, rows: VendorRow[] | null): boolean {
  return !!c && !!rows && showVendorUi(rows) && activeVendorsOf(rows).some((v) => v.id === c);
}

/**
 * The vendor a REPORT should filter by: '' for every vendor. '' until a set
 * choice is confirmed to name an active vendor among 2+ — never a guess.
 */
export function useReportVendorFilter(): string {
  const s = useStore(!!choice);
  return validChoice(s.choice, s.vendors) ? s.choice : '';
}

export interface ReportVendor {
  /** The vendor to filter by, or '' for every vendor. */
  vendor: string;
  setVendor: (id: string) => void;
  /** True when 2+ vendors are active — the only time the filter exists. */
  show: boolean;
  options: Array<{ value: string; label: string }>;
}

/** The control's view: always reads the vendor list. */
export function useReportVendor(): ReportVendor {
  const s = useStore(true);
  const rows = s.vendors;
  /* A stale choice (its vendor gone, or back to one vendor) is dropped once
     the list is known, so it cannot come back later as a surprise. */
  useEffect(() => {
    if (rows && s.choice && !validChoice(s.choice, rows)) setChoice('');
  }, [rows, s.choice]);
  return useMemo(() => {
    const list = rows ?? [];
    return {
      vendor: validChoice(s.choice, rows) ? s.choice : '',
      setVendor: setChoice,
      show: showVendorUi(list),
      options: activeVendorsOf(list)
        .map((v) => ({ value: v.id, label: v.name ?? v.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [rows, s.choice]);
}

/**
 * AND a vendor clause onto a Directus filter. `path` is where the vendor sits
 * relative to the collection: `['vendor']` on tickets and chats,
 * `['conversation', 'vendor']` on CSAT, routing events and messages. No vendor =
 * the filter untouched.
 */
export function withVendor<F>(
  filter: F,
  vendor: string,
  path: readonly string[] = ['vendor'],
): F | { _and: unknown[] } {
  if (!vendor) return filter;
  const clause = path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), { _eq: vendor });
  const empty =
    filter === null ||
    filter === undefined ||
    (typeof filter === 'object' && Object.keys(filter as object).length === 0);
  return empty ? { _and: [clause] } : { _and: [filter, clause] };
}

/** The filter control, in the reports' label-over-select anatomy. Null with one vendor. */
export function ReportVendorFilter({ className }: { className?: string }) {
  const { t } = useTranslation();
  const rv = useReportVendor();
  if (!rv.show) return null;
  const label = t('reports.vendor', { defaultValue: 'Vendor' });
  return (
    <label className={className ?? 'flex flex-col gap-1'}>
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <SelectMenu
        size="sm"
        className="w-[10rem]"
        aria-label={label}
        value={rv.vendor}
        onChange={rv.setVendor}
        options={[
          { value: '', label: t('reports.allVendors', { defaultValue: 'All vendors' }) },
          ...rv.options,
        ]}
      />
    </label>
  );
}

/** Clear the choice — for Clear buttons that own a report's other filters. */
export function clearReportVendor(): void {
  setChoice('');
}

/** Test hook: forget the vendor list and (unless kept) the remembered choice. */
export function resetReportVendor({ keepChoice = false }: { keepChoice?: boolean } = {}): void {
  vendors = null;
  vendorsAt = 0;
  pending = null;
  if (!keepChoice) setChoice('');
  emit();
}
