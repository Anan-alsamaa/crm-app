import { createItem, readItems, updateItem } from '@directus/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { directus } from '../../lib/directus.js';
import { logActivity } from '../activity/api.js';

export interface Campaign {
  id: string;
  name: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  budget: number | string | null;
  status: 'active' | 'archived';
  date_created: string;
}

export type CampaignForm = Pick<Campaign, 'name' | 'goal' | 'start_date' | 'end_date' | 'budget'>;

/** Every campaign, newest first. Archived ones only when asked for. */
export function useCampaigns(includeArchived = false) {
  return useQuery({
    queryKey: ['marketing-campaigns', includeArchived],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'marketing_campaigns' as never,
          {
            sort: ['-date_created'],
            limit: 200,
            fields: ['*'],
            ...(includeArchived ? {} : { filter: { status: { _eq: 'active' } } }),
          } as never,
        ),
      )) as unknown as Campaign[],
  });
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['marketing-campaigns'] });
    void qc.invalidateQueries({ queryKey: ['marketing-activity'] });
  };
}

/** Create a campaign, or change one (`id`). */
export function useSaveCampaign() {
  const done = useDone();
  return useMutation({
    mutationFn: async (v: { id?: string; form: CampaignForm }) => {
      const row = (await directus.request(
        v.id
          ? updateItem('marketing_campaigns' as never, v.id, v.form as never)
          : createItem('marketing_campaigns' as never, v.form as never),
      )) as unknown as { id: string };
      await logActivity({
        action: v.id ? 'campaign_changed' : 'campaign_created',
        subject_type: 'campaign',
        subject_id: row.id,
        summary: `${v.id ? 'Campaign changed' : 'Campaign created'}: ${v.form.name}`,
      });
      return row;
    },
    onSuccess: done,
  });
}

/** Archive (or bring back) a campaign. Its coupons are untouched. */
export function useArchiveCampaign() {
  const done = useDone();
  return useMutation({
    mutationFn: async (v: { campaign: Campaign; archived: boolean }) => {
      await directus.request(
        updateItem('marketing_campaigns' as never, v.campaign.id, {
          status: v.archived ? 'archived' : 'active',
        } as never),
      );
      await logActivity({
        action: v.archived ? 'campaign_archived' : 'campaign_restored',
        subject_type: 'campaign',
        subject_id: v.campaign.id,
        summary: `${v.archived ? 'Campaign archived' : 'Campaign restored'}: ${v.campaign.name}`,
      });
    },
    onSuccess: done,
  });
}
