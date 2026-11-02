import { createItem, readItems } from '@directus/sdk';
import { useQuery } from '@tanstack/react-query';
import { directus } from '../../lib/directus.js';

/** One line of the Marketing portal's append-only log (`marketing_activity`). */
export interface MarketingActivity {
  id: string;
  date_created: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  summary: string | null;
  user_created: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

export const ACTIVITY_PAGE_SIZE = 50;

/** The newest activity first, one page at a time. */
export function useActivity(limit = ACTIVITY_PAGE_SIZE) {
  return useQuery({
    queryKey: ['marketing-activity', limit],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'marketing_activity' as never,
          {
            sort: ['-date_created'],
            limit,
            fields: [
              'id',
              'date_created',
              'action',
              'subject_type',
              'subject_id',
              'summary',
              'user_created.first_name',
              'user_created.last_name',
              'user_created.email',
            ],
          } as never,
        ),
      )) as unknown as MarketingActivity[],
  });
}

/**
 * Write one line to the log.
 *
 * Best-effort ON PURPOSE: the log records work, it must never block it. A role
 * that may open the portal but not prepare anything has no create grant, and
 * its sign-in simply is not logged.
 */
export async function logActivity(entry: {
  action: string;
  summary: string;
  subject_type?: string;
  subject_id?: string;
  detail?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await directus.request(createItem('marketing_activity' as never, entry as never));
    return true;
  } catch {
    return false;
  }
}
