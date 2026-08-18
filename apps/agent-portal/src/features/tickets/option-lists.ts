import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  CommunicationMethod,
  Compensation,
  ComplaintSource,
  ComplaintType,
  ServiceType,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * The dropdown values behind the complaint form, read LIVE from `option_lists`.
 *
 * These used to be Zod enums baked into the bundle, which meant the operations
 * team adding a complaint type was a code change and a deploy. The enums are
 * still here — as the FALLBACK when the collection is unreadable (an older
 * permission set, a cold start) — so the form degrades to exactly its old
 * behaviour rather than to empty dropdowns.
 *
 * Values are returned in the admin's chosen order. Deactivated values stop
 * being OFFERED but never stop being DISPLAYED: an old ticket carrying a
 * retired value keeps showing it, because rewriting history is worse than an
 * unfashionable label.
 */
const FALLBACK: Record<string, readonly string[]> = {
  complaint_type: ComplaintType.options,
  service_type: ServiceType.options,
  complaint_source: ComplaintSource.options,
  communication_method: CommunicationMethod.options,
  compensation: Compensation.options,
  // Born editable, so there is no enum to fall back to — these are the seeded
  // starting values, used only when option_lists cannot be read at all.
  issuing_side: ['Marketing', 'Operations', 'Delivery'],
  delivery_type: ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'],
  coupon_type: ['Private', 'Public'],
  discount_category: ['Amount', 'Percentage'],
};

interface OptionRow {
  list: string;
  value: string;
  sort: number | null;
  active: boolean;
}

/** Every active list at once — one request feeds all five dropdowns. */
export function useOptionLists() {
  return useQuery({
    queryKey: ['option-lists'],
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, string[]>> => {
      const rows = (await directus.request(
        readItems(
          'option_lists' as never,
          {
            limit: -1,
            filter: { active: { _eq: true } },
            sort: ['list', 'sort', 'value'],
            fields: ['list', 'value', 'sort', 'active'],
          } as never,
        ),
      )) as unknown as OptionRow[];
      const out: Record<string, string[]> = {};
      for (const r of rows) (out[r.list] ??= []).push(r.value);
      return out;
    },
  });
}

/**
 * Values for one dropdown, with `current` kept offered even when it has been
 * retired from the list — the select must never silently blank a stored value.
 */
export function optionsFor(
  lists: Record<string, string[]> | undefined,
  key: keyof typeof FALLBACK,
  current?: string | null,
): string[] {
  const live = lists?.[key];
  const base = live && live.length > 0 ? live : [...FALLBACK[key]!];
  if (current && !base.includes(current)) return [current, ...base];
  return base;
}
