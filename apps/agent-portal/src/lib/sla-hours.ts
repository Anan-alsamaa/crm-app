import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { slaHoursByGoverns, type SlaHoursByObject } from '@yiji/shared-types';
import { directus } from './directus.js';

/**
 * THE WORKING HOURS THE REPORTS COUNT IN (owner, 2026-10-08).
 *
 * The SLA engine counts a deadline in working time only (the policy's
 * `business_hours`); the reports used to count the same chats and tickets on
 * the wall clock, so a reply at 08:52 to a 05:35 message read as 3h17m when the
 * shift opens at 09:00. Report durations now go through `businessMsBetween`
 * with these hours: the CHAT policy's for chat timings, the TICKET policy's for
 * ticket timings. Same rule as the admin portal's copy.
 *
 * The Agent role and every app role read `sla_policies` (roles.ts /
 * app-roles-sync BASELINE). A failed read must not empty a report, so it falls
 * back to null — the wall clock, the numbers shown before — and says so.
 */
export const NO_SLA_HOURS: SlaHoursByObject = { chat: null, ticket: null };

export async function loadSlaHours(): Promise<SlaHoursByObject> {
  try {
    const rows = (await directus.request(
      readItems(
        'sla_policies' as never,
        { fields: ['id', 'name', 'governs', 'business_hours', 'active'], limit: -1 } as never,
      ),
    )) as unknown as Array<{
      id: string;
      name: string | null;
      governs: string | null;
      active: boolean | null;
      business_hours: unknown;
    }>;
    return slaHoursByGoverns(rows);
  } catch (err) {
    console.warn('[sla-hours] could not read sla_policies; reports use the wall clock:', err);
    return NO_SLA_HOURS;
  }
}

/** `loadSlaHours` as a query, shared by every report page (one read per 10 minutes). */
export function useSlaHours() {
  return useQuery({
    queryKey: ['sla-business-hours'],
    queryFn: loadSlaHours,
    staleTime: 10 * 60_000,
  });
}
