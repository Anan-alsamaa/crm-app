import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { ComplaintSource, ComplaintType, ServiceType } from '@yiji/shared-types';
import { directus } from './directus.js';

/**
 * The dropdown values operations owns, read for the admin console's own forms.
 *
 * The agent portal has had this since the lists became editable; the admin
 * console only ever EDITED them (Dropdown values) and never read them back, so
 * a form here that needs complaint types had nowhere to get them. The SLA
 * coverage picker is the first: it must offer exactly the types tickets are
 * actually filed under, or an operator would write a policy against a type
 * that no ticket can ever carry and it would simply never fire.
 *
 * Enums stay as the FALLBACK for a cold start or a permission set that cannot
 * read `option_lists` — the picker degrades to the built-in vocabulary rather
 * than to nothing, because an empty list of choices reads as a broken page.
 */
const FALLBACK: Record<string, readonly string[]> = {
  complaint_type: ComplaintType.options,
  service_type: ServiceType.options,
  complaint_source: ComplaintSource.options,
};

interface OptionRow {
  list: string;
  value: string;
  sort: number | null;
  active: boolean;
}

/**
 * Every active list at once — one request, cached for the session's forms.
 *
 * `enabled` because the only consumers so far are inside drawers: a console
 * page that fires a request for a form nobody has opened is how a list view
 * gets slow one hook at a time.
 */
export function useOptionLists(enabled = true) {
  return useQuery({
    queryKey: ['option-lists'],
    enabled,
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
 * Values for one list, with anything already SELECTED kept on offer even after
 * it was retired.
 *
 * Without this, opening an old policy for an unrelated edit would quietly drop
 * the retired values out of its coverage the moment you pressed Save — the
 * checkbox for them would not exist, so the form would submit a narrower
 * policy than the one you opened, and nothing would say so.
 */
export function optionsWith(
  lists: Record<string, string[]> | undefined,
  key: keyof typeof FALLBACK,
  selected: readonly string[] = [],
): string[] {
  const live = lists?.[key];
  const base = live && live.length > 0 ? live : [...FALLBACK[key]!];
  const extra = selected.filter((v) => v && !base.includes(v));
  return [...extra, ...base];
}
