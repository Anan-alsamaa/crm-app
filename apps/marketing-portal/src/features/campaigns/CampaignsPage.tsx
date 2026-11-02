import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { marketingCouponMaxCost } from '@yiji/shared-types';
import {
  Button,
  DateField,
  Drawer,
  EmptyState,
  FormField,
  Input,
  MeterBar,
  Spinner,
  Textarea,
  cn,
  toast,
} from '@yiji/ui';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { useMarketingCoupons, type MarketingCoupon } from '../coupons/api.js';
import {
  useArchiveCampaign,
  useCampaigns,
  useSaveCampaign,
  type Campaign,
  type CampaignForm,
} from './api.js';

const BLANK_CAMPAIGN: CampaignForm = {
  name: '',
  goal: '',
  start_date: null,
  end_date: null,
  budget: '',
};

const SAR = (n: number) => `${Math.round(n).toLocaleString()} SAR`;

/** Coupons that count against a budget: anything not rejected, cancelled or refused. */
const COUNTS = new Set(['draft', 'pending', 'approved', 'sending', 'created']);

/**
 * CAMPAIGNS (owner, 2026-11-02): a name, a goal, dates and a budget that
 * marketing coupons and bulk sends belong to. The budget is compared with the
 * MOST the campaign's coupons can cost - the ceiling, not a guess. How many
 * were actually used needs Yiji's data and arrives with the marketing account.
 */
export function CampaignsPage() {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const campaigns = useCampaigns(showArchived);
  const coupons = useMarketingCoupons();
  const archive = useArchiveCampaign();
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [open, setOpen] = useState(false);

  const byCampaign = useMemo(() => {
    const m = new Map<string, MarketingCoupon[]>();
    for (const c of coupons.data ?? []) {
      const id = (c as MarketingCoupon & { campaign?: string | null }).campaign;
      if (id) m.set(id, [...(m.get(id) ?? []), c]);
    }
    return m;
  }, [coupons.data]);

  const rows = campaigns.data ?? [];
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('campaigns.title', { defaultValue: 'Campaigns' })}
        description={t('campaigns.desc', {
          defaultValue:
            'Plan a campaign with its dates and budget, then attach marketing coupons and bulk sends to it. Each coupon is still approved on its own.',
        })}
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowArchived((v) => !v)}>
              {showArchived
                ? t('campaigns.hideArchived', { defaultValue: 'Hide archived' })
                : t('campaigns.showArchived', { defaultValue: 'Show archived' })}
            </Button>
            <Button
              variant="brand"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              {t('campaigns.new', { defaultValue: 'New campaign' })}
            </Button>
          </>
        }
      />
      <div className={PAGE_BODY}>
        {campaigns.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('campaigns.empty', { defaultValue: 'No campaigns yet' })}
            description={t('campaigns.emptyHint', {
              defaultValue: 'Press "New campaign" to plan the first one.',
            })}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {rows.map((c) => {
              const list = byCampaign.get(c.id) ?? [];
              const live = list.filter((x) => COUNTS.has(x.status));
              const codes = live.filter((x) => x.audience !== 'list').length;
              const bulks = live.filter((x) => x.audience === 'list').length;
              const reached = live.reduce((s, x) => s + (x.sent_count ?? 0), 0);
              const ceiling = live.reduce((s, x) => s + marketingCouponMaxCost(x), 0);
              const budget = Number(c.budget) || 0;
              const over = budget > 0 && ceiling > budget;
              return (
                <div key={c.id} className={cn(SECTION_CARD, 'p-5')}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="text-md font-semibold">{c.name}</h2>
                    {c.status === 'archived' && (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs text-muted-foreground">
                        {t('campaigns.archived', { defaultValue: 'Archived' })}
                      </span>
                    )}
                    <span className="ms-auto text-xs tabular-nums text-muted-foreground">
                      {c.start_date ? String(c.start_date).slice(0, 10) : '…'} →{' '}
                      {c.end_date ? String(c.end_date).slice(0, 10) : '…'}
                    </span>
                  </div>
                  {c.goal && <p className="mt-1 text-sm text-muted-foreground">{c.goal}</p>}
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
                    <span>
                      {t('campaigns.codes', { defaultValue: 'Coupons' })}: <b>{codes}</b>
                    </span>
                    <span>
                      {t('campaigns.bulks', { defaultValue: 'Bulk sends' })}: <b>{bulks}</b>
                    </span>
                    <span>
                      {t('campaigns.reached', { defaultValue: 'Customers given a coupon' })}:{' '}
                      <b>{reached.toLocaleString()}</b>
                    </span>
                  </div>
                  <div className="mt-3 text-sm tabular-nums">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t('campaigns.ceiling', { defaultValue: 'Most it can cost' })}
                      </span>
                      <span className={over ? 'font-semibold text-destructive' : ''}>
                        {SAR(ceiling)}
                        {budget > 0 &&
                          ` / ${SAR(budget)} ${t('campaigns.budget', { defaultValue: 'budget' })}`}
                      </span>
                    </div>
                    {budget > 0 && (
                      <MeterBar
                        className="mt-2"
                        value={Math.min(100, Math.round((ceiling / budget) * 100))}
                        tone={over ? 'destructive' : 'primary'}
                      />
                    )}
                    {over && (
                      <p className="mt-1 text-xs text-destructive">
                        {t('campaigns.over', {
                          defaultValue:
                            'If every use is redeemed this campaign goes over its budget.',
                        })}
                      </p>
                    )}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(c);
                        setOpen(true);
                      }}
                    >
                      {t('actions.edit', { defaultValue: 'Edit' })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={archive.isPending}
                      onClick={() =>
                        archive.mutate(
                          { campaign: c, archived: c.status !== 'archived' },
                          {
                            onError: () =>
                              toast.error(
                                t('campaigns.archiveFailed', {
                                  defaultValue: 'Could not change the campaign',
                                }),
                              ),
                          },
                        )
                      }
                    >
                      {c.status === 'archived'
                        ? t('campaigns.restore', { defaultValue: 'Bring back' })
                        : t('campaigns.archive', { defaultValue: 'Archive' })}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <CampaignDrawer open={open} campaign={editing} onClose={() => setOpen(false)} />
    </div>
  );
}

function CampaignDrawer({
  open,
  campaign,
  onClose,
}: {
  open: boolean;
  campaign: Campaign | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveCampaign();
  const [form, setForm] = useState<CampaignForm>(BLANK_CAMPAIGN);
  useEffect(() => {
    if (open)
      setForm(
        campaign
          ? {
              name: campaign.name,
              goal: campaign.goal ?? '',
              start_date: campaign.start_date ? String(campaign.start_date).slice(0, 10) : null,
              end_date: campaign.end_date ? String(campaign.end_date).slice(0, 10) : null,
              budget: campaign.budget ?? '',
            }
          : BLANK_CAMPAIGN,
      );
  }, [open, campaign]);

  const go = async () => {
    if (!form.name.trim()) {
      toast.error(t('campaigns.nameNeeded', { defaultValue: 'Give the campaign a name.' }));
      return;
    }
    if (form.start_date && form.end_date && form.end_date < form.start_date) {
      toast.error(
        t('campaigns.datesWrong', { defaultValue: 'The end cannot be before the start.' }),
      );
      return;
    }
    try {
      await save.mutateAsync({
        id: campaign?.id,
        form: {
          name: form.name.trim(),
          goal: (form.goal ?? '').trim() || null,
          start_date: form.start_date || null,
          end_date: form.end_date || null,
          budget: form.budget === '' || form.budget === null ? null : Number(form.budget),
        },
      });
      toast.success(t('campaigns.saved', { defaultValue: 'Campaign saved' }));
      onClose();
    } catch {
      toast.error(t('campaigns.saveFailed', { defaultValue: 'Could not save the campaign' }));
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        campaign
          ? t('campaigns.editTitle', { defaultValue: 'Change campaign' })
          : t('campaigns.newTitle', { defaultValue: 'New campaign' })
      }
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('actions.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button variant="brand" disabled={save.isPending} onClick={() => void go()}>
            {t('actions.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('campaigns.name', { defaultValue: 'Name' })} className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label={t('campaigns.goal', { defaultValue: 'Goal' })} className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.goal ?? ''}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
          />
        </FormField>
        <FormField label={t('campaigns.start', { defaultValue: 'Starts' })}>
          <DateField
            value={form.start_date ?? ''}
            onChange={(v) => setForm({ ...form, start_date: v || null })}
          />
        </FormField>
        <FormField label={t('campaigns.end', { defaultValue: 'Ends' })}>
          <DateField
            value={form.end_date ?? ''}
            onChange={(v) => setForm({ ...form, end_date: v || null })}
          />
        </FormField>
        <FormField label={t('campaigns.budgetField', { defaultValue: 'Budget (SAR, optional)' })}>
          <Input
            type="number"
            inputMode="decimal"
            value={String(form.budget ?? '')}
            onChange={(e) => setForm({ ...form, budget: e.target.value })}
          />
        </FormField>
      </div>
    </Drawer>
  );
}
