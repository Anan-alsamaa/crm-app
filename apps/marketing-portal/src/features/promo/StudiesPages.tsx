import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, FormField, HBarChart, Input, Pill, Select, Skeleton, cn, toast } from '@yiji/ui';
import {
  OBJECTIVE_CATALOGUE,
  forecastCampaign,
  objectiveSpec,
  offerLabel,
  type CampaignObjective,
  type Study,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine } from '../../engine/index.js';
import { CampaignDraftFromSpec, scheduleFor } from '../../engine/sample.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  AreaTabs,
  KeyValue,
  Panel,
  SampleDataPill,
  Tile,
  WorkflowStrip,
  daysAgo,
  int,
  pct,
  sar,
  today,
  useEngineQuery,
  useObjectiveLabels,
} from './shared.js';

/**
 * PRE-STUDIES (Ayman): "Check a coupon on paper before you spend on it: read
 * your orders, pick the best opportunity, prove the business case, then
 * launch." Four tabs - overview, your order data, opportunities, business
 * cases - plus the customer groups.
 */
function useStudyTabs() {
  const { t } = useTranslation();
  return [
    {
      to: '/pre-studies',
      label: t('promo.studies.tabOverview', { defaultValue: 'Overview' }),
      end: true,
    },
    {
      to: '/pre-studies/data',
      label: t('promo.studies.tabData', { defaultValue: '1 · Order data' }),
    },
    {
      to: '/pre-studies/opportunities',
      label: t('promo.studies.tabOpportunities', { defaultValue: '2 · Opportunities' }),
    },
    {
      to: '/pre-studies/cases',
      label: t('promo.studies.tabCases', { defaultValue: '3 · Business cases' }),
    },
    {
      to: '/pre-studies/groups',
      label: t('promo.studies.tabGroups', { defaultValue: 'Customer groups' }),
    },
  ];
}

const STAGES: Study['stage'][] = [
  'draft',
  'finance_review',
  'waiting_approval',
  'approved',
  'running',
  'finished',
];

function useStageLabels(): Record<Study['stage'], string> {
  const { t } = useTranslation();
  return {
    draft: t('promo.studies.stage.draft', { defaultValue: 'Draft' }),
    finance_review: t('promo.studies.stage.finance_review', { defaultValue: 'Finance review' }),
    waiting_approval: t('promo.studies.stage.waiting_approval', {
      defaultValue: 'Waiting approval',
    }),
    approved: t('promo.studies.stage.approved', { defaultValue: 'Approved' }),
    running: t('promo.studies.stage.running', { defaultValue: 'Running' }),
    finished: t('promo.studies.stage.finished', { defaultValue: 'Finished' }),
  };
}

function nextStep(
  s: Study,
  t: (k: string, o: { defaultValue: string }) => string,
): [string, string] {
  switch (s.stage) {
    case 'draft':
      return [
        t('promo.studies.next.draft', { defaultValue: 'Compare scenarios and submit for review' }),
        'Marketing',
      ];
    case 'finance_review':
      return [
        t('promo.studies.next.finance', {
          defaultValue: 'Check the assumptions and mark as reviewed',
        }),
        'Finance',
      ];
    case 'waiting_approval':
      return [
        t('promo.studies.next.approval', { defaultValue: 'Approve or send back' }),
        'Marketing manager',
      ];
    case 'approved':
      return [
        t('promo.studies.next.approved', { defaultValue: 'Turn it into a coupon' }),
        'Marketing',
      ];
    case 'running':
      return [
        t('promo.studies.next.running', {
          defaultValue: 'Monitor plan vs actual and act on alerts',
        }),
        'Marketing & Finance',
      ];
    case 'finished':
      return [
        t('promo.studies.next.finished', { defaultValue: 'Write the lessons learned' }),
        'Marketing',
      ];
  }
}

export function StudiesOverviewPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const tabs = useStudyTabs();
  const stages = useStageLabels();
  const studies = useEngineQuery(['studies'], (e) => e.listStudies());
  const counts = useMemo(
    () =>
      Object.fromEntries(
        STAGES.map((s) => [s, (studies.data ?? []).filter((x) => x.stage === s).length]),
      ),
    [studies.data],
  );
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.studies.title', { defaultValue: 'Pre-studies' })}
        description={t('promo.studies.desc', {
          defaultValue:
            'Check a coupon on paper before you spend on it: read your orders, pick the best opportunity, prove the business case, then launch.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => nav('/pre-studies/opportunities')}>
              {t('promo.studies.findOpportunities', { defaultValue: 'Find opportunities' })}
            </Button>
            <Button onClick={() => nav('/pre-studies/cases?new=1')}>
              {t('promo.studies.newStudy', { defaultValue: '+ New study' })}
            </Button>
          </div>
        }
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={1} />
        <AreaTabs tabs={tabs} />
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [
              '/pre-studies/data',
              t('promo.studies.card1', { defaultValue: '1 · Your order data' }),
              t('promo.studies.card1Body', {
                defaultValue:
                  'Read your orders from the engine. The study reads customers, baskets and timing.',
              }),
            ],
            [
              '/pre-studies/opportunities',
              t('promo.studies.card2', { defaultValue: '2 · Opportunities' }),
              t('promo.studies.card2Body', {
                defaultValue:
                  'Every coupon model ranked by expected return on your own data, with how the customer will see it.',
              }),
            ],
            [
              '/pre-studies/cases',
              t('promo.studies.card3', { defaultValue: '3 · Business cases' }),
              t('promo.studies.card3Body', {
                defaultValue:
                  'Compare scenarios, get finance review and approval, then turn it into a coupon.',
              }),
            ],
            [
              '/pre-studies/groups',
              t('promo.studies.card4', { defaultValue: 'Customer groups' }),
              t('promo.studies.card4Body', {
                defaultValue:
                  'RFM groups: who is loyal, who is at risk, who is lost, and the goal that fits each.',
              }),
            ],
          ].map(([to, title, body]) => (
            <NavLink key={to} to={to!} className={cn(SECTION_CARD, 'block p-4 hover:shadow-float')}>
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{body}</p>
              <span className="mt-2 block text-xs font-semibold text-primary">
                {t('promo.studies.open', { defaultValue: 'Open →' })}
              </span>
            </NavLink>
          ))}
        </div>
        <Panel
          title={t('promo.studies.where', { defaultValue: 'Where the studies are' })}
          aside={
            <NavLink to="/pre-studies/cases" className="text-xs font-semibold text-primary">
              {t('promo.studies.allStudies', { defaultValue: 'All studies →' })}
            </NavLink>
          }
        >
          <ol className="mb-4 flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <li key={s} className="rounded-xl bg-secondary/50 px-4 py-2 text-center">
                <div className="text-lg font-extrabold tabular-nums text-foreground">
                  {counts[s]}
                </div>
                <div className="text-2xs text-muted-foreground">{stages[s]}</div>
              </li>
            ))}
          </ol>
          {studies.isLoading && <Skeleton className="h-24 w-full" />}
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-start">
                  {t('promo.studies.study', { defaultValue: 'Study' })}
                </th>
                <th className="text-start">
                  {t('promo.studies.stageCol', { defaultValue: 'Stage' })}
                </th>
                <th className="text-start">
                  {t('promo.studies.nextStep', { defaultValue: 'Next step' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {(studies.data ?? []).map((s) => {
                const [step, who] = nextStep(s, t);
                return (
                  <tr key={s.id} className="border-t border-foreground/[0.06]">
                    <td className="py-2">
                      <NavLink
                        to={`/pre-studies/cases/${s.id}`}
                        className="font-semibold text-primary"
                      >
                        {s.name}
                      </NavLink>
                      <div className="font-mono text-2xs text-muted-foreground">{s.id}</div>
                    </td>
                    <td>
                      <Pill
                        tone={
                          s.stage === 'running'
                            ? 'success'
                            : s.stage === 'finished'
                              ? 'neutral'
                              : s.stage === 'draft'
                                ? 'neutral'
                                : 'warning'
                        }
                        size="sm"
                      >
                        {stages[s.stage]}
                      </Pill>
                    </td>
                    <td>
                      {step}
                      <div className="text-2xs text-muted-foreground">{who}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

export function StudiesDataPage() {
  const { t } = useTranslation();
  const tabs = useStudyTabs();
  const [range, setRange] = useState({ from: daysAgo(180), to: today() });
  const orders = useEngineQuery(['orders-export', range.from, range.to], (e) =>
    e.ordersExport(range),
  );
  const stats = useMemo(() => {
    const rows = orders.data ?? [];
    const done = rows.filter((r) => r.completed);
    const customers = new Set(done.map((r) => r.customerId));
    const revenue = done.reduce((s, r) => s + r.totalSar, 0);
    const perCustomer = new Map<string, number>();
    for (const r of done) perCustomer.set(r.customerId, (perCustomer.get(r.customerId) ?? 0) + 1);
    const repeat = [...perCustomer.values()].filter((n) => n >= 2).length;
    const byDay = new Map<string, number>();
    for (const r of done)
      byDay.set(r.placedAt.slice(0, 10), (byDay.get(r.placedAt.slice(0, 10)) ?? 0) + 1);
    const byDow = [0, 0, 0, 0, 0, 0, 0];
    for (const r of done) byDow[new Date(r.placedAt).getDay()]! += 1;
    const byType: Record<string, number> = {};
    for (const r of done) byType[r.orderType] = (byType[r.orderType] ?? 0) + 1;
    return {
      rows: rows.length,
      completed: done.length,
      notCompleted: rows.length - done.length,
      brands: new Set(done.map((r) => r.brandId)).size,
      cities: new Set(done.map((r) => r.city)).size,
      customers: customers.size,
      revenue,
      avg: done.length ? revenue / done.length : 0,
      perCustomer: customers.size ? done.length / customers.size : 0,
      repeatPct: customers.size ? (repeat / customers.size) * 100 : 0,
      byDow,
      byType,
      days: byDay.size,
    };
  }, [orders.data]);
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.studies.dataTitle', { defaultValue: 'Campaign pre-study · your data' })}
        description={t('promo.studies.dataDesc', {
          defaultValue:
            'The engine’s completed orders for the period: customers, baskets and timing. Everything downstream reads from this.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={1} />
        <AreaTabs tabs={tabs} />
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <FormField label={t('promo.studies.from', { defaultValue: 'From' })}>
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          </FormField>
          <FormField label={t('promo.studies.to', { defaultValue: 'To' })}>
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          </FormField>
          <span className="pb-2 text-xs text-muted-foreground">
            {orders.isFetching
              ? t('promo.studies.reading', { defaultValue: 'Reading orders…' })
              : t('promo.studies.readSummary', {
                  defaultValue: '{{rows}} rows read · {{days}} days',
                  rows: int(stats.rows),
                  days: stats.days,
                })}
          </span>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Tile
            label={t('promo.studies.completedOrders', { defaultValue: 'Completed orders' })}
            value={int(stats.completed)}
          />
          <Tile
            label={t('promo.studies.notCompleted', { defaultValue: 'Not completed' })}
            value={int(stats.notCompleted)}
          />
          <Tile
            label={t('promo.studies.customers', { defaultValue: 'Customers' })}
            value={int(stats.customers)}
          />
          <Tile
            label={t('promo.studies.revenue', { defaultValue: 'Revenue' })}
            value={sar(stats.revenue)}
          />
          <Tile
            label={t('promo.studies.avgOrder', { defaultValue: 'Average order' })}
            value={sar(stats.avg)}
          />
          <Tile
            label={t('promo.studies.ordered2', { defaultValue: 'Ordered 2+ times' })}
            value={pct(stats.repeatPct)}
            caption={t('promo.studies.perCustomer', {
              defaultValue: '{{n}} orders per customer',
              n: stats.perCustomer.toFixed(2),
            })}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title={t('promo.studies.byDow', { defaultValue: 'Completed orders by day of week' })}
          >
            <HBarChart
              rows={dows.map((d, i) => ({ label: d, values: { orders: stats.byDow[i] ?? 0 } }))}
              series={[
                {
                  key: 'orders',
                  label: t('promo.studies.orders', { defaultValue: 'Orders' }),
                  tone: 'primary',
                },
              ]}
              format={(v) => int(v)}
            />
          </Panel>
          <Panel title={t('promo.studies.byType', { defaultValue: 'Orders by type' })}>
            <HBarChart
              rows={Object.entries(stats.byType).map(([k, v]) => ({
                label: k.toLowerCase(),
                values: { orders: v },
              }))}
              series={[
                {
                  key: 'orders',
                  label: t('promo.studies.orders', { defaultValue: 'Orders' }),
                  tone: 'sky',
                },
              ]}
              format={(v) => int(v)}
            />
          </Panel>
        </div>
        <p className="mt-3 text-2xs text-muted-foreground">
          {t('promo.studies.dataNote', {
            defaultValue:
              'Brands: {{b}} · Cities: {{c}}. Phone numbers are never shown on this page.',
            b: stats.brands,
            c: stats.cities,
          })}
        </p>
      </div>
    </div>
  );
}

export function StudiesOpportunitiesPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const tabs = useStudyTabs();
  const labels = useObjectiveLabels();
  const range = { from: daysAgo(180), to: today() };
  const opps = useEngineQuery(['opportunities', range.from], (e) => e.opportunities(range));
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.studies.oppTitle', { defaultValue: 'Campaign opportunities' })}
        description={t('promo.studies.oppDesc', {
          defaultValue:
            'Every coupon model ranked by the expected return on your own data. Open one as a study to compare scenarios.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={1} />
        <AreaTabs tabs={tabs} />
        {opps.isLoading && <Skeleton className="h-40 w-full" />}
        <div className="grid gap-3">
          {(opps.data ?? []).map((o, i) => (
            <div
              key={o.objective}
              className={cn(
                SECTION_CARD,
                'grid gap-2 p-4 sm:grid-cols-[2rem_1fr_auto_auto_auto] sm:items-center',
              )}
            >
              <div className="text-lg font-extrabold text-muted-foreground">{i + 1}</div>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {labels[o.objective]?.title}
                </div>
                <div className="text-xs text-muted-foreground">{o.recommendedOfferText}</div>
              </div>
              <div className="text-xs">
                <span className="font-bold tabular-nums text-foreground">
                  {int(o.customersMatched)}
                </span>{' '}
                <span className="text-muted-foreground">
                  {t('promo.studies.match', { defaultValue: 'customers match' })}
                </span>
              </div>
              <div className="text-xs">
                <span
                  className={cn(
                    'font-bold tabular-nums',
                    o.expectedNetSar < 0 ? 'text-destructive' : 'text-success',
                  )}
                >
                  {sar(o.expectedNetSar)}
                </span>{' '}
                <span className="text-muted-foreground">· {pct(o.expectedReturnPct)}</span>
              </div>
              <Button
                size="sm"
                onClick={() => nav(`/pre-studies/cases?new=1&objective=${o.objective}`)}
              >
                {t('promo.studies.openStudy', { defaultValue: 'Open pre-study' })}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StudiesCasesPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const tabs = useStudyTabs();
  const stages = useStageLabels();
  const labels = useObjectiveLabels();
  const engine = useEngine();
  const qc = useQueryClient();
  const { user } = useAuth();
  const studies = useEngineQuery(['studies'], (e) => e.listStudies());
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [objective, setObjective] = useState<CampaignObjective>(
    (params.get('objective') as CampaignObjective | null) ?? 'REPEAT_PURCHASE',
  );
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const spec = objectiveSpec(objective);
      const start = today();
      const scenarios = [20, 30, 45].map((rate, i) => {
        const draft = CampaignDraftFromSpec(spec, {
          name: { en: `${name} - option ${i + 1}`, ar: `${name} - خيار ${i + 1}` },
          schedule: scheduleFor(start, spec.recommended.validityDays),
        });
        const input = {
          customersMatched: 2400 + i * 300,
          redemptionRatePct: rate,
          avgOrderSar: 67,
        };
        return {
          id: `s${i + 1}`,
          label: [
            t('promo.studies.cautious', { defaultValue: 'Cautious' }),
            t('promo.studies.balanced', { defaultValue: 'Balanced' }),
            t('promo.studies.aggressive', { defaultValue: 'Aggressive' }),
          ][i]!,
          draft,
          input,
          forecast: forecastCampaign(draft, input),
        };
      });
      const id = `STU-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
      const study: Study = {
        id,
        name,
        stage: 'draft',
        objective,
        createdBy: user?.id ?? 'me',
        createdAt: new Date().toISOString(),
        period: { from: daysAgo(180), to: today() },
        data: {
          rowsRead: 0,
          completedOrders: 0,
          notCompleted: 0,
          brands: 0,
          cities: 0,
          customers: 0,
          revenueSar: 0,
        },
        scenarios,
        chosenScenarioId: null,
        review: { by: null, at: null, note: null },
        approval: {
          requestedBy: null,
          requestedAt: null,
          decidedBy: null,
          decidedAt: null,
          note: null,
        },
        campaignId: null,
      };
      return engine.saveStudy(study);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['promo'] });
      setCreating(false);
      nav(`/pre-studies/cases/${s.id}`);
    },
    onError: (e) =>
      toast.error(t('promo.studies.createFailed', { defaultValue: 'Could not create the study' }), {
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.studies.casesTitle', { defaultValue: 'Business cases' })}
        description={t('promo.studies.casesDesc', {
          defaultValue:
            'Three scenarios per study, the finance review, the approval, and the campaign it became.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <Button onClick={() => setCreating(true)}>
            {t('promo.studies.newStudy', { defaultValue: '+ New study' })}
          </Button>
        }
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={2} />
        <AreaTabs tabs={tabs} />
        {creating && (
          <Panel
            title={t('promo.studies.newStudyTitle', { defaultValue: 'New study' })}
            className="mb-4"
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <FormField label={t('promo.studies.name', { defaultValue: 'Study name' })}>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label={t('promo.wizard.objective', { defaultValue: 'Objective' })}>
                <Select
                  value={objective}
                  onChange={(e) => setObjective(e.target.value as CampaignObjective)}
                >
                  {OBJECTIVE_CATALOGUE.map((o) => (
                    <option key={o.key} value={o.key}>
                      {labels[o.key]?.title}
                    </option>
                  ))}
                </Select>
              </FormField>
              <div className="flex gap-2">
                <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
                  {t('promo.studies.create', { defaultValue: 'Create' })}
                </Button>
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                </Button>
              </div>
            </div>
          </Panel>
        )}
        {studies.isLoading && <Skeleton className="h-40 w-full" />}
        <div className="grid gap-3">
          {(studies.data ?? []).map((s) => {
            const chosen = s.scenarios.find((x) => x.id === s.chosenScenarioId) ?? s.scenarios[1];
            return (
              <NavLink
                key={s.id}
                to={`/pre-studies/cases/${s.id}`}
                className={cn(
                  SECTION_CARD,
                  'grid gap-2 p-4 hover:shadow-float sm:grid-cols-[1fr_auto_auto_auto] sm:items-center',
                )}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-2xs text-muted-foreground">{s.id}</span>
                    <Pill
                      tone={
                        s.stage === 'running'
                          ? 'success'
                          : s.stage === 'draft' || s.stage === 'finished'
                            ? 'neutral'
                            : 'warning'
                      }
                      size="sm"
                    >
                      {stages[s.stage]}
                    </Pill>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-foreground">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{labels[s.objective]?.title}</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('promo.studies.scenarios', {
                    defaultValue: '{{n}} scenarios',
                    n: s.scenarios.length,
                  })}
                </div>
                <div className="text-xs">
                  {chosen ? (
                    <>
                      <span className="font-bold tabular-nums text-foreground">
                        {sar(chosen.forecast.netSar)}
                      </span>{' '}
                      <span className="text-muted-foreground">· {pct(chosen.forecast.roiPct)}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.campaignId
                    ? t('promo.studies.became', {
                        defaultValue: 'Campaign {{id}}',
                        id: s.campaignId,
                      })
                    : t('promo.studies.by', { defaultValue: 'by {{who}}', who: s.createdBy })}
                </div>
              </NavLink>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function StudyDetailPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const engine = useEngine();
  const qc = useQueryClient();
  const { user, can } = useAuth();
  const stages = useStageLabels();
  const labels = useObjectiveLabels();
  const study = useEngineQuery(['study', id], (e) => e.getStudy(id));
  const s = study.data;
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: (next: Study) => engine.saveStudy(next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['promo'] }),
    onError: (e) =>
      toast.error(t('promo.studies.saveFailed', { defaultValue: 'Could not save the study' }), {
        description: (e as Error).message,
      }),
  });
  const launch = useMutation({
    mutationFn: async () => {
      if (!s) throw new Error('no study');
      const sc =
        s.scenarios.find((x) => x.id === (chosen ?? s.chosenScenarioId)) ?? s.scenarios[0]!;
      const c = await engine.saveCampaign({
        ...sc.draft,
        studyId: s.id,
        name: { en: s.name, ar: sc.draft.name.ar },
      });
      await engine.saveStudy({ ...s, stage: 'running', campaignId: c.id });
      return c;
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['promo'] });
      toast.success(
        t('promo.studies.launched', {
          defaultValue: 'Campaign {{id}} created from the study.',
          id: c.id,
        }),
      );
      nav(`/coupons/${c.id}`);
    },
  });
  if (study.isLoading)
    return (
      <div className={PAGE_BODY}>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (!s)
    return (
      <div className={PAGE_BODY}>
        <p className="text-sm text-muted-foreground">
          {t('promo.studies.notFound', { defaultValue: 'No study with that id.' })}
        </p>
      </div>
    );
  const current = chosen ?? s.chosenScenarioId;
  const mine = s.createdBy === (user?.id ?? '');
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={s.name}
        description={`${s.id} · ${labels[s.objective]?.title} · ${t('promo.studies.period', { defaultValue: 'period {{f}} → {{t}}', f: s.period.from, t: s.period.to })}`}
        titleExtra={
          <span className="flex items-center gap-2">
            <Pill tone={s.stage === 'running' ? 'success' : 'warning'} size="sm">
              {stages[s.stage]}
            </Pill>
            <SampleDataPill />
          </span>
        }
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={2} />
        <div className="grid gap-3 md:grid-cols-3">
          {s.scenarios.map((sc) => (
            <button
              key={sc.id}
              type="button"
              onClick={() => setChosen(sc.id)}
              aria-pressed={current === sc.id}
              className={cn(
                SECTION_CARD,
                'p-4 text-start',
                current === sc.id && 'ring-2 ring-primary/50',
              )}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">{sc.label}</h2>
                {current === sc.id && (
                  <Pill tone="primary" size="sm">
                    {t('promo.studies.chosen', { defaultValue: 'Chosen' })}
                  </Pill>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {offerLabel(sc.draft.offer)} · min. SAR {sc.draft.rules.minOrderSar}
              </div>
              <KeyValue
                rows={[
                  [
                    t('promo.wizard.customersMatch', { defaultValue: 'Customers who match' }),
                    int(sc.input.customersMatched),
                  ],
                  [
                    t('promo.wizard.redemptionRate', { defaultValue: 'Expected redemption (%)' }),
                    pct(sc.input.redemptionRatePct),
                  ],
                  [
                    t('promo.wizard.expectedCost', { defaultValue: 'Expected cost' }),
                    sar(sc.forecast.discountSar + sc.forecast.messageCostSar),
                  ],
                  [
                    t('promo.wizard.extraOrders', { defaultValue: 'Extra orders expected' }),
                    int(sc.forecast.expectedOrders),
                  ],
                  [
                    t('promo.wizard.expectedNet', { defaultValue: 'Expected net' }),
                    <span className={sc.forecast.netSar < 0 ? 'text-destructive' : 'text-success'}>
                      {sar(sc.forecast.netSar)} · {pct(sc.forecast.roiPct)}
                    </span>,
                  ],
                ]}
              />
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title={t('promo.studies.reviewTitle', { defaultValue: 'Finance review' })}>
            {s.review.at ? (
              <p className="text-sm text-muted-foreground">
                {t('promo.studies.reviewed', {
                  defaultValue: 'Reviewed by {{who}} on {{when}}: {{note}}',
                  who: s.review.by,
                  when: s.review.at.slice(0, 10),
                  note: s.review.note ?? '',
                })}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('promo.studies.notReviewed', { defaultValue: 'Not reviewed yet.' })}
              </p>
            )}
            {s.stage === 'finance_review' && can('approve_marketing') && (
              <div className="mt-2 flex gap-2">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('promo.studies.reviewNote', { defaultValue: 'What was checked' })}
                  className="h-9 flex-1"
                />
                <Button
                  size="sm"
                  onClick={() =>
                    save.mutate({
                      ...s,
                      stage: 'waiting_approval',
                      review: { by: user?.id ?? 'finance', at: new Date().toISOString(), note },
                    })
                  }
                >
                  {t('promo.studies.markReviewed', { defaultValue: 'Mark as reviewed' })}
                </Button>
              </div>
            )}
          </Panel>
          <Panel title={t('promo.studies.approvalTitle', { defaultValue: 'Approval and launch' })}>
            {s.stage === 'draft' && (
              <Button
                size="sm"
                disabled={!current}
                onClick={() =>
                  save.mutate({
                    ...s,
                    stage: 'finance_review',
                    chosenScenarioId: current,
                    approval: {
                      ...s.approval,
                      requestedBy: user?.id ?? 'me',
                      requestedAt: new Date().toISOString(),
                    },
                  })
                }
              >
                {t('promo.studies.submit', { defaultValue: 'Submit for review' })}
              </Button>
            )}
            {s.stage === 'waiting_approval' &&
              can('approve_marketing') &&
              (mine ? (
                <p className="text-sm text-muted-foreground">
                  {t('promo.approvals.ownCampaign', {
                    defaultValue: 'You created this campaign, so another user must approve it.',
                  })}
                </p>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      save.mutate({
                        ...s,
                        stage: 'approved',
                        approval: {
                          ...s.approval,
                          decidedBy: user?.id ?? 'manager',
                          decidedAt: new Date().toISOString(),
                          note,
                        },
                      })
                    }
                  >
                    {t('promo.approvals.approve', { defaultValue: 'Approve' })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() =>
                      save.mutate({
                        ...s,
                        stage: 'draft',
                        approval: {
                          ...s.approval,
                          decidedBy: user?.id ?? 'manager',
                          decidedAt: new Date().toISOString(),
                          note: note || 'sent back',
                        },
                      })
                    }
                  >
                    {t('promo.studies.sendBack', { defaultValue: 'Send back' })}
                  </Button>
                </div>
              ))}
            {s.stage === 'approved' && can('manage_marketing') && (
              <Button size="sm" disabled={launch.isPending} onClick={() => launch.mutate()}>
                {t('promo.studies.turnIntoCoupon', { defaultValue: 'Turn into a coupon' })}
              </Button>
            )}
            {s.campaignId && (
              <NavLink
                to={`/coupons/${s.campaignId}`}
                className="mt-2 block text-xs font-semibold text-primary"
              >
                {t('promo.studies.openCampaign', {
                  defaultValue: 'Open campaign {{id}} →',
                  id: s.campaignId,
                })}
              </NavLink>
            )}
            {s.stage === 'running' && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('promo.studies.runningHint', {
                  defaultValue:
                    'Plan vs actual is on the Performance page; mark the study finished when the campaign ends.',
                })}
              </p>
            )}
            {s.stage === 'running' && can('manage_marketing') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => save.mutate({ ...s, stage: 'finished' })}
              >
                {t('promo.studies.markFinished', { defaultValue: 'Mark finished' })}
              </Button>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function StudiesGroupsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const tabs = useStudyTabs();
  const labels = useObjectiveLabels();
  const groups = useEngineQuery(['customer-groups'], (e) =>
    e.customerGroups({ from: daysAgo(180), to: today() }),
  );
  const names: Record<string, [string, string]> = {
    LOYAL: [
      t('promo.groups.loyal', { defaultValue: 'Loyal' }),
      t('promo.groups.loyalBody', {
        defaultValue: 'Ordered 4+ times in 90 days. Reward, never discount.',
      }),
    ],
    HIGH_VALUE: [
      t('promo.groups.highValue', { defaultValue: 'High value' }),
      t('promo.groups.highValueBody', { defaultValue: 'Top 10% by spend. Cashback keeps them.' }),
    ],
    AT_RISK: [
      t('promo.groups.atRisk', { defaultValue: 'At risk' }),
      t('promo.groups.atRiskBody', { defaultValue: 'Used to order often; 30–60 days quiet.' }),
    ],
    LOST: [
      t('promo.groups.lost', { defaultValue: 'Lost' }),
      t('promo.groups.lostBody', {
        defaultValue: 'No order in 60+ days. A fixed amount works best.',
      }),
    ],
    NEW: [
      t('promo.groups.new', { defaultValue: 'New' }),
      t('promo.groups.newBody', { defaultValue: 'One order. Second-order push.' }),
    ],
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.groups.title', { defaultValue: 'Customer groups' })}
        description={t('promo.groups.desc', {
          defaultValue:
            'Who is loyal, who is at risk, who is lost, and the goal that fits each group.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={1} />
        <AreaTabs tabs={tabs} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {(groups.data ?? []).map((g) => (
            <div key={g.key} className={cn(SECTION_CARD, 'p-4')}>
              <h2 className="text-sm font-semibold text-foreground">{names[g.key]?.[0]}</h2>
              <div className="mt-1 text-xl font-extrabold tabular-nums text-foreground">
                {int(g.customers)}
              </div>
              <div className="text-2xs text-muted-foreground">
                {pct(g.share)} {t('promo.groups.ofCustomers', { defaultValue: 'of customers' })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{names[g.key]?.[1]}</p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => nav(`/coupons/new?objective=${g.goal}`)}
              >
                {labels[g.goal]?.title}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StudyDetailRoute() {
  const { id = '' } = useParams();
  return <StudyDetailPage id={id} />;
}
