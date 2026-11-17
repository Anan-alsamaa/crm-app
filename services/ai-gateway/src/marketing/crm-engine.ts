import { z } from 'zod';
import {
  CAMPAIGN_OBJECTIVES,
  StoredCampaignDraft,
  campaignUniquenessConflicts,
  type CampaignDraft,
  DEFAULT_MONEY_MODEL,
  MARKETING_BRANDS,
  MARKETING_LIST_MAX,
  ORDER_TYPES,
  campaignApprovalReasons,
  campaignCode,
  canApproveCampaign,
  lockedFieldChanges,
  normalizePhone,
  simulateCampaignCheckout,
  type Campaign,
  type CampaignForecast,
  type CampaignPerformance,
  type CampaignStatus,
  type CheckoutSimulation,
  type CustomerGroup,
  type EarningRule,
  type EngineCatalogue,
  type GiftCardActivity,
  type GiftCardProduct,
  type GiftCardStats,
  type HomeSummary,
  type IssuanceResult,
  type Liability,
  type MoneyModel,
  type Opportunity,
  type OrdersExportRow,
  type Redemption,
  type RewardsCampaign,
  type RewardsItem,
  type RewardsMember,
  type RewardsStats,
  type Study,
} from '@yiji/shared-types';
import {
  campaignCouponProblems,
  campaignCouponRow,
  issuanceBlockers,
  perUseCeilingSar,
  usesPerCustomer,
} from './campaign-coupon.js';
import { draftOf, type CampaignRecord, type EngineStore } from './engine-store.js';

/**
 * THE CRM'S MARKETING ENGINE (owner, 2026-11-16).
 *
 * The `MarketingEngine` contract, answered by the CRM itself: the external
 * engine the portal's live mode was waiting for will not exist (Yiji v2 does
 * nothing for marketing). Every RULE lives here, on the server - the portal
 * shows the same rules, but a browser can be talked around and this cannot:
 *
 *   - who may do what: `manage_marketing` prepares, `approve_marketing`
 *     decides, the Administrator holds both;
 *   - FOUR EYES: the creator never decides their own campaign or study;
 *   - the business case: the approval reasons (cost above the threshold, a
 *     deep discount, a forecast loss) are recomputed here from the draft and
 *     the money model, never taken on the page's word;
 *   - LOCKED_WHEN_LIVE: once customers may hold the coupon, the offer, the
 *     audience, the code, the rules and the start date never change;
 *   - an approved campaign that is edited loses its approval;
 *   - issuance only after approval, through the existing coupon sender, never
 *     wider than approved and never past the redemption or budget ceiling.
 *
 * What the CRM has no data for (redemptions, gift card sales, points) answers
 * honestly empty or zero in the same shapes the sample engine uses, so every
 * page renders; see the PR / docs/MARKETING-ENGINE-CONTRACT.md for the list.
 */

export interface Actor {
  id: string;
  isAdmin: boolean;
  privileges: Record<string, boolean>;
}

/** A refusal the routes turn into `{ error: code, detail }` with this status. */
export class EngineRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code);
    this.name = 'EngineRefusal';
  }
}

export const canPrepare = (a: Actor) => a.isAdmin || a.privileges.manage_marketing === true;
export const canDecide = (a: Actor) => a.isAdmin || a.privileges.approve_marketing === true;

function requirePrepare(a: Actor) {
  if (!canPrepare(a)) throw new EngineRefusal(403, 'manage_marketing_required');
}
function requireDecide(a: Actor) {
  if (!canDecide(a)) throw new EngineRefusal(403, 'approve_marketing_required');
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ForecastInput = z
  .object({
    customersMatched: z.number(),
    expectedRedemptions: z.number(),
    expectedOrders: z.number(),
    avgOrderSar: z.number(),
    discountSar: z.number(),
    revenueSar: z.number(),
    extraProfitSar: z.number(),
    messageCostSar: z.number(),
    netSar: z.number(),
    roiPct: z.number(),
    mostItCanCostSar: z.number(),
    needsApproval: z.boolean(),
    approvalReasons: z.array(z.string().max(64)).max(20),
  })
  .strip();

const GiftCardInput = z.object({
  name: z.object({ en: z.string().trim().min(1).max(80), ar: z.string().trim().min(1).max(80) }),
  valueSar: z.number().min(1),
  priceSar: z.number().min(0),
  validityDays: z.number().int().min(1).max(3650),
  design: z.object({
    background: z.string().max(32),
    accent: z.string().max(32),
    message: z.string().max(200),
  }),
  active: z.boolean(),
  canCombineWithCoupons: z.boolean(),
});

const pct = z.number().min(0).max(100);
const EarningRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  cashbackPct: z.object({ DELIVERY: pct, PICKUP: pct, CARHOP: pct, DINE_IN: pct }),
  brandIds: z.array(z.string().max(64)).max(50),
  active: z.boolean(),
  validFrom: day,
  validTo: day.nullable(),
});

const nullableText = z.string().max(1000).nullable();
const StudyInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(120),
  stage: z.enum(['draft', 'finance_review', 'waiting_approval', 'approved', 'running', 'finished']),
  objective: z.enum(CAMPAIGN_OBJECTIVES),
  period: z.object({ from: day, to: day }),
  data: z.object({
    rowsRead: z.number(),
    completedOrders: z.number(),
    notCompleted: z.number(),
    brands: z.number(),
    cities: z.number(),
    customers: z.number(),
    revenueSar: z.number(),
  }),
  /* A scenario's draft is checked as a campaign when it is turned into one. */
  scenarios: z
    .array(
      z.object({
        id: z.string().max(80),
        label: z.string().max(80),
        draft: z.record(z.unknown()),
        input: z.object({
          customersMatched: z.number(),
          redemptionRatePct: z.number(),
          avgOrderSar: z.number(),
        }),
        forecast: z.record(z.unknown()),
      }),
    )
    .max(10),
  chosenScenarioId: z.string().max(80).nullable(),
  review: z.object({ by: nullableText, at: nullableText, note: nullableText }),
  approval: z.object({
    requestedBy: nullableText,
    requestedAt: nullableText,
    decidedBy: nullableText,
    decidedAt: nullableText,
    note: nullableText,
  }),
  campaignId: z.string().max(40).nullable(),
});

/** The first problem zod found, as `path: message` - the 422 names the field. */
function firstIssue(e: z.ZodError): { field: string; message: string } {
  const i = e.issues[0];
  return { field: i?.path.join('.') ?? '', message: i?.message ?? 'invalid' };
}

const MONEY_KEYS = [
  'foodCostPct',
  'packagingPct',
  'wouldOrderAnywayPct',
  'approvalAboveSar',
  'deepDiscountPct',
] as const;

/** The finance setting over the default model; anything malformed keeps the default. */
export function mergeMoneyModel(raw: unknown): MoneyModel {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return DEFAULT_MONEY_MODEL;
    }
  }
  if (!v || typeof v !== 'object') return DEFAULT_MONEY_MODEL;
  const o = v as Record<string, unknown>;
  const m: MoneyModel = {
    ...DEFAULT_MONEY_MODEL,
    channelCostPct: { ...DEFAULT_MONEY_MODEL.channelCostPct },
    messageCostSar: { ...DEFAULT_MONEY_MODEL.messageCostSar },
  };
  for (const k of MONEY_KEYS) {
    const n = Number(o[k]);
    if (o[k] !== undefined && Number.isFinite(n) && n >= 0) m[k] = n;
  }
  if (typeof o.version === 'string' && o.version.trim()) m.version = o.version.trim().slice(0, 32);
  for (const [group, target] of [
    ['channelCostPct', m.channelCostPct],
    ['messageCostSar', m.messageCostSar],
  ] as const) {
    const src = o[group];
    if (src && typeof src === 'object')
      for (const key of Object.keys(target)) {
        const n = Number((src as Record<string, unknown>)[key]);
        if ((src as Record<string, unknown>)[key] !== undefined && Number.isFinite(n) && n >= 0)
          (target as Record<string, number>)[key] = n;
      }
  }
  return m;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => dayOf(new Date(Date.parse(d) + n * 86_400_000));
const emptyApproval = () => ({
  requestedBy: null,
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  note: null,
});

/** Status changes a person may make on the detail page. */
const STATUS_MOVES: Record<'live' | 'paused' | 'ended', CampaignStatus[]> = {
  live: ['approved', 'paused'],
  paused: ['live'],
  ended: ['live', 'paused'],
};

export interface CrmEngineOptions {
  now?: () => Date;
  random?: () => number;
  /**
   * Runs `fn` alone for `key` (one issuance per campaign at a time, review
   * 2026-11-16: two simultaneous issue calls both passed the ceiling check).
   * Production passes a Redis lock (every gateway task); the default only
   * serialises within this process.
   */
  withLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

/** One promise chain per key: calls for the same key run one after another. */
export function processLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    tails.set(key, run);
    try {
      return await run;
    } finally {
      if (tails.get(key) === run) tails.delete(key);
    }
  };
}

/** The Redis client calls a lock needs (ioredis shape). */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
}

/**
 * A lock across gateway tasks: SET NX with an expiry, released only by its
 * owner. Waits up to `waitMs`, then refuses (409) rather than issue twice.
 */
export function redisLock(
  redis: LockRedis,
  opts: { ttlMs?: number; waitMs?: number; prefix?: string } = {},
): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const ttl = opts.ttlMs ?? 120_000;
  const wait = opts.waitMs ?? 15_000;
  const prefix = opts.prefix ?? 'marketing:lock:';
  return async (key, fn) => {
    const k = prefix + key;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const until = Date.now() + wait;
    for (;;) {
      if ((await redis.set(k, token, 'PX', ttl, 'NX')) === 'OK') break;
      if (Date.now() > until) throw new EngineRefusal(409, 'issuance_in_progress');
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      return await fn();
    } finally {
      await redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          k,
          token,
        )
        .catch(() => undefined);
    }
  };
}

export class CrmMarketingEngine {
  readonly kind = 'live' as const;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  constructor(
    private readonly store: EngineStore,
    opts: CrmEngineOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.withLock = opts.withLock ?? processLock();
  }
  private iso() {
    return this.now().toISOString();
  }
  private async log(
    actor: Actor,
    action: string,
    subjectType: string,
    subjectId: string,
    summary: string,
    detail: Record<string, unknown> = {},
  ) {
    await this.store.logActivity({
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      summary,
      detail: { by: actor.id, ...detail },
    });
  }

  /* ── reference data ─────────────────────────────────────────────────── */

  async moneyModel(): Promise<MoneyModel> {
    return mergeMoneyModel(await this.store.moneyModelSetting().catch(() => null));
  }

  /**
   * Brands are the ones a marketing coupon can carry (Yiji's brand ids, the
   * same list the coupon form uses); branches are the CRM's stores. The CRM
   * holds no menu, so categories and products are empty.
   */
  async catalogue(): Promise<EngineCatalogue> {
    const stores = await this.store.catalogueStores().catch(() => []);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const brands = MARKETING_BRANDS.map((b) => ({ id: String(b.yijiId), name: b.name }));
    const brandFor = (name: string | null) => {
      if (!name) return '';
      const n = norm(name);
      const hit = MARKETING_BRANDS.find((b) => norm(b.name) === n || n.includes(norm(b.name)));
      return hit ? String(hit.yijiId) : '';
    };
    return {
      brands,
      branches: stores.map((s) => ({
        id: s.id,
        brandId: brandFor(s.brandName),
        name: s.name,
        city: s.city ?? '',
      })),
      categories: [],
      products: [],
    };
  }

  /* ── campaigns ──────────────────────────────────────────────────────── */

  async listCampaigns(filter: { status?: string; objective?: string } = {}): Promise<Campaign[]> {
    const all = (await this.store.listCampaigns()).map((r) => r.campaign);
    return all
      .filter((c) => !filter.status || filter.status === 'all' || c.status === filter.status)
      .filter((c) => !filter.objective || c.objective === filter.objective)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    return (await this.store.getCampaign(id))?.campaign ?? null;
  }

  private async record(id: string): Promise<CampaignRecord> {
    const r = await this.store.getCampaign(id);
    if (!r) throw new EngineRefusal(404, 'campaign_not_found');
    return r;
  }

  /**
   * Today's shape, or the one before field parity (a portal deployed after
   * the gateway still sends `validity`): both are upgraded, then checked
   * against the design's rules.
   */
  private parseDraft(body: unknown): CampaignDraft {
    const parsed = StoredCampaignDraft.safeParse(body);
    if (!parsed.success) throw new EngineRefusal(422, 'invalid_campaign', firstIssue(parsed.error));
    return parsed.data;
  }

  private async newCampaignId(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const id = campaignCode('CMP');
      if (!(await this.store.getCampaign(id))) return id;
    }
    throw new EngineRefusal(503, 'no_free_campaign_id');
  }

  async saveCampaign(actor: Actor, body: unknown, id?: string): Promise<Campaign> {
    requirePrepare(actor);
    const draft = this.parseDraft(body);
    const now = this.iso();
    /* The design: the English name is unique, a shared code is unique across
       the campaigns that hold or will hold it. */
    const others = (await this.store.listCampaigns()).map((r) => r.campaign);
    const taken = campaignUniquenessConflicts(draft, id, others);
    if (taken.length) throw new EngineRefusal(409, 'not_unique', { fields: taken });
    if (!id) {
      const c: Campaign = {
        ...draft,
        id: await this.newCampaignId(),
        status: 'draft',
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        approval: emptyApproval(),
        snapshot: null,
        changeLog: [{ at: now, by: actor.id, what: 'created' }],
      };
      const saved = await this.store.insertCampaign(c);
      await this.log(actor, 'prepared', 'campaign', c.id, `Campaign created: ${c.name.en}`);
      return saved.campaign;
    }
    const { rowId, campaign: prev } = await this.record(id);
    /* What the approver is looking at does not move under them. */
    if (prev.status === 'waiting_approval')
      throw new EngineRefusal(409, 'waiting_approval', { status: prev.status });
    const locked = lockedFieldChanges(prev, draft);
    if (locked.length) throw new EngineRefusal(422, 'locked_while_live', { fields: locked });
    const changed = JSON.stringify(draftOf(prev)) !== JSON.stringify(draftOf(draft));
    /* An approval is of THIS campaign: change it and it needs approving again. */
    const withdraw = changed && prev.status === 'approved';
    const next: Campaign = {
      ...prev,
      ...draft,
      ...(withdraw ? { status: 'draft' as const, approval: emptyApproval(), snapshot: null } : {}),
      updatedAt: now,
      changeLog: [
        ...prev.changeLog,
        {
          at: now,
          by: actor.id,
          what: withdraw ? 'edited after approval - approval withdrawn' : 'edited',
        },
      ],
    };
    const saved = await this.store.updateCampaign(rowId, next);
    await this.log(
      actor,
      withdraw ? 'approval_withdrawn' : 'edited',
      'campaign',
      id,
      `Campaign edited: ${next.name.en}`,
    );
    return saved.campaign;
  }

  async submitForApproval(actor: Actor, id: string, body: unknown): Promise<Campaign> {
    requirePrepare(actor);
    const { rowId, campaign: c } = await this.record(id);
    if (!['draft', 'rejected', 'finance_review'].includes(c.status))
      throw new EngineRefusal(409, 'not_submittable', { status: c.status });
    const f = ForecastInput.safeParse((body as { forecast?: unknown } | null)?.forecast);
    if (!f.success) throw new EngineRefusal(422, 'invalid_forecast', firstIssue(f.error));
    const model = await this.moneyModel();
    const approvalReasons = campaignApprovalReasons(c, f.data, model);
    const mostItCanCostSar = Math.max(
      f.data.mostItCanCostSar,
      c.limits.budgetSar + Math.max(0, f.data.messageCostSar),
    );
    const snapshot: CampaignForecast = {
      ...f.data,
      mostItCanCostSar,
      approvalReasons,
      needsApproval: approvalReasons.length > 0,
    };
    const now = this.iso();
    const next: Campaign = {
      ...c,
      status: 'waiting_approval',
      snapshot,
      approval: { ...emptyApproval(), requestedBy: actor.id, requestedAt: now },
      updatedAt: now,
      changeLog: [...c.changeLog, { at: now, by: actor.id, what: 'sent for approval' }],
    };
    const saved = await this.store.updateCampaign(rowId, next);
    await this.log(actor, 'submitted', 'campaign', id, `Campaign sent for approval: ${c.name.en}`, {
      approvalReasons,
      moneyModel: model.version,
    });
    return saved.campaign;
  }

  async decideCampaign(actor: Actor, id: string, body: unknown): Promise<Campaign> {
    requireDecide(actor);
    const b = z
      .object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).default('') })
      .safeParse(body);
    if (!b.success) throw new EngineRefusal(422, 'invalid_decision', firstIssue(b.error));
    const { rowId, campaign: c } = await this.record(id);
    const gate = canApproveCampaign(c, actor.id);
    if (!gate.ok)
      throw gate.reason === 'own'
        ? new EngineRefusal(403, 'own_campaign')
        : new EngineRefusal(409, 'not_waiting_approval', { status: c.status });
    const now = this.iso();
    const model = await this.moneyModel();
    /* The reasons as of the decision, against today's money model. */
    const snapshot = c.snapshot
      ? (() => {
          const reasons = campaignApprovalReasons(c, c.snapshot!, model);
          return { ...c.snapshot!, approvalReasons: reasons, needsApproval: reasons.length > 0 };
        })()
      : null;
    if (b.data.decision === 'approve' && !snapshot)
      throw new EngineRefusal(409, 'no_business_case');
    const approve = b.data.decision === 'approve';
    const next: Campaign = {
      ...c,
      status: approve ? 'approved' : 'rejected',
      snapshot: approve ? snapshot : c.snapshot,
      approval: { ...c.approval, decidedBy: actor.id, decidedAt: now, note: b.data.note },
      updatedAt: now,
      changeLog: [
        ...c.changeLog,
        { at: now, by: actor.id, what: approve ? 'approved' : 'rejected' },
      ],
    };
    const saved = await this.store.updateCampaign(rowId, next);
    await this.log(
      actor,
      approve ? 'approved' : 'rejected',
      'campaign',
      id,
      `Campaign ${approve ? 'approved' : 'rejected'}: ${c.name.en}`,
      { approvalReasons: snapshot?.approvalReasons ?? [], note: b.data.note },
    );
    return saved.campaign;
  }

  async setCampaignStatus(actor: Actor, id: string, body: unknown): Promise<Campaign> {
    requirePrepare(actor);
    const b = z.object({ status: z.enum(['live', 'paused', 'ended']) }).safeParse(body);
    if (!b.success) throw new EngineRefusal(422, 'invalid_status', firstIssue(b.error));
    const target = b.data.status;
    const { rowId, campaign: c } = await this.record(id);
    if (!STATUS_MOVES[target].includes(c.status))
      throw new EngineRefusal(409, 'bad_transition', { from: c.status, to: target });
    if (target === 'live' && !(c.approval.decidedBy && c.approval.decidedBy !== c.createdBy))
      throw new EngineRefusal(409, 'not_approved');
    const now = this.iso();
    const next: Campaign = {
      ...c,
      status: target,
      updatedAt: now,
      changeLog: [...c.changeLog, { at: now, by: actor.id, what: target }],
    };
    const saved = await this.store.updateCampaign(rowId, next);
    await this.log(actor, target, 'campaign', id, `Campaign ${target}: ${c.name.en}`);
    return saved.campaign;
  }

  /* ── issuance (the existing marketing coupon sender does the sending) ─ */

  async issue(actor: Actor, body: unknown): Promise<IssuanceResult> {
    requirePrepare(actor);
    const b = z
      .object({
        campaignId: z.string().min(1).max(40),
        customerIds: z.array(z.string().max(80)).min(1).max(MARKETING_LIST_MAX),
      })
      .safeParse(body);
    if (!b.success) throw new EngineRefusal(422, 'invalid_issuance', firstIssue(b.error));
    const { rowId, campaign: c } = await this.record(b.data.campaignId);
    if (c.status !== 'approved' && c.status !== 'live')
      throw new EngineRefusal(409, 'not_issuable_status', { status: c.status });
    if (!(c.approval.decidedBy && c.approval.decidedBy !== c.createdBy))
      throw new EngineRefusal(409, 'not_approved');
    if (c.audience.mode === 'ALL') throw new EngineRefusal(409, 'audience_all');
    const today = dayOf(this.now());
    const blockers = issuanceBlockers(c, today);
    if (blockers.length) throw new EngineRefusal(422, 'not_issuable', { fields: blockers });
    return this.withLock(`issue:${c.id}`, () => this.issueLocked(actor, rowId, c, b.data));
  }

  private async issueLocked(
    actor: Actor,
    rowId: string,
    c: Campaign,
    input: { campaignId: string; customerIds: string[] },
  ): Promise<IssuanceResult> {
    /* A PHONES campaign was approved for THOSE numbers (review 2026-11-16):
       nobody else may receive it. */
    const approvedPhones =
      c.audience.mode === 'PHONES'
        ? new Set(c.audience.phoneNumbers.map((p) => normalizePhone(p)))
        : null;

    const skipped: IssuanceResult['skipped'] = [];
    const requested = input.customerIds.length;
    /* Who each id is: a Saudi mobile as given, or the CRM contact that
       carries this Yiji customer id. */
    const raw = input.customerIds.map((s) => s.trim()).filter(Boolean);
    const unresolved = raw.filter((id) => !/^05\d{8}$/.test(normalizePhone(id)));
    const known = unresolved.length
      ? await this.store.phonesForCustomers(unresolved)
      : new Map<string, string>();
    /* Holders are recipients of a batch that was really released: a batch
       whose write broke halfway (coupon still pending, or cancelled) holds
       nobody, so a retry reaches those customers (review 2026-11-16). */
    const already = new Set(
      (await this.store.campaignRecipients(rowId))
        .filter(
          (r) =>
            r.status !== 'failed' &&
            !['pending', 'cancelled', 'rejected', 'draft'].includes(r.couponStatus ?? 'approved'),
        )
        .map((r) => r.phone),
    );
    const each = usesPerCustomer(c) ?? 1;
    const perUse = perUseCeilingSar(c);
    const ceiling = Math.min(
      Math.floor(c.limits.totalRedemptions / each),
      perUse > 0 ? Math.floor(c.limits.budgetSar / (perUse * each)) : Number.MAX_SAFE_INTEGER,
    );
    let room = Math.max(0, ceiling - already.size);
    const picked: string[] = [];
    const seen = new Set<string>();
    for (const id of raw) {
      const direct = normalizePhone(id);
      const phone = /^05\d{8}$/.test(direct) ? direct : normalizePhone(known.get(id) ?? '');
      if (!/^05\d{8}$/.test(phone)) {
        skipped.push({ customerId: id, reason: 'no Saudi mobile number for this customer' });
        continue;
      }
      if (seen.has(phone)) {
        skipped.push({ customerId: id, reason: 'listed twice' });
        continue;
      }
      if (approvedPhones && !approvedPhones.has(phone)) {
        skipped.push({ customerId: id, reason: 'not in the approved list of numbers' });
        continue;
      }
      seen.add(phone);
      if (already.has(phone)) {
        skipped.push({ customerId: id, reason: 'already holds this coupon' });
        continue;
      }
      if (inControlGroup(c.id, phone, c.audience.controlGroupPct)) {
        skipped.push({ customerId: id, reason: 'control group (held back to measure the lift)' });
        continue;
      }
      if (room <= 0) {
        skipped.push({ customerId: id, reason: 'campaign limit reached (redemptions or budget)' });
        continue;
      }
      room -= 1;
      picked.push(phone);
    }
    if (!picked.length) return { batchId: '', requested, issued: 0, skipped };
    const row = campaignCouponRow(c, rowId, picked.length, {
      firstBatch: already.size === 0,
      today: dayOf(this.now()),
      random: this.random,
    });
    const problems = campaignCouponProblems(row);
    if (problems.length) throw new EngineRefusal(422, 'coupon_problems', { problems });
    const { couponId } = await this.store.createListCoupon(
      { ...row, submitted_at: this.iso() },
      picked,
      { decidedBy: c.approval.decidedBy, now: this.now },
    );
    await this.log(
      actor,
      'issued',
      'campaign',
      c.id,
      `Campaign issued to ${picked.length} customers: ${c.name.en}`,
      {
        couponId,
        code: row.code,
        requested,
        issued: picked.length,
        skipped: skipped.length,
      },
    );
    return { batchId: row.code, requested, issued: picked.length, skipped };
  }

  /* ── results ────────────────────────────────────────────────────────── */

  async performance(id: string): Promise<CampaignPerformance> {
    const { rowId, campaign: c } = await this.record(id);
    const recipients = await this.store.campaignRecipients(rowId);
    const sent = recipients.filter((r) => r.status === 'sent');
    const byDay = new Map<string, number>();
    for (const r of sent) {
      const d = (r.sent_at ?? r.date_created ?? '').slice(0, 10);
      if (d) byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    return {
      campaignId: c.id,
      issued: sent.length,
      /* Redemptions are Yiji's; the CRM receives none yet. */
      redeemed: 0,
      revenueSar: 0,
      discountSar: 0,
      extraOrders: 0,
      extraProfitSar: 0,
      roiPct: 0,
      controlGroup: null,
      perDay: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, issued]) => ({ day: d, issued, redeemed: 0, revenueSar: 0 })),
      plan: c.snapshot,
    };
  }

  async redemptions(id: string): Promise<Redemption[]> {
    await this.record(id);
    return [];
  }

  async liability(): Promise<Liability> {
    const model = await this.moneyModel();
    const live = (await this.store.listCampaigns()).filter((r) => r.campaign.status === 'live');
    const face = live.reduce((s, r) => s + r.campaign.limits.budgetSar, 0);
    const byProduct: Liability['byProduct'] = [
      {
        product: 'coupons',
        faceValueSar: face,
        atCostSar: Math.round(face * ((model.foodCostPct + model.packagingPct) / 100)),
        count: live.length,
      },
      { product: 'compensation', faceValueSar: 0, atCostSar: 0, count: 0 },
      { product: 'gift_cards', faceValueSar: 0, atCostSar: 0, count: 0 },
      { product: 'points', faceValueSar: 0, atCostSar: 0, count: 0 },
    ];
    return {
      asOf: this.iso(),
      byProduct,
      totalFaceValueSar: byProduct.reduce((s, x) => s + x.faceValueSar, 0),
    };
  }

  async home(): Promise<HomeSummary> {
    const records = await this.store.listCampaigns();
    const cs = records.map((r) => r.campaign);
    const live = cs.filter((c) => c.status === 'live');
    const perf = await Promise.all(live.map((c) => this.performance(c.id).catch(() => null)));
    const studies = await this.store.listStudies();
    const alerts: HomeSummary['alerts'] = [];
    for (const c of cs.filter((x) => x.status === 'waiting_approval'))
      alerts.push({
        id: `approval-${c.id}`,
        area: 'coupons',
        title: `Waiting for approval - ${c.name.en}`,
        body: `${c.id} needs a second person.`,
        severity: 'info',
      });
    const measured = perf.filter((p): p is CampaignPerformance => !!p && p.redeemed > 0);
    return {
      asOf: this.iso(),
      coupons: {
        live: live.length,
        redeemed: measured.reduce((s, p) => s + p.redeemed, 0),
        discountSar: measured.reduce((s, p) => s + p.discountSar, 0),
        waitingApproval: cs.filter((c) => c.status === 'waiting_approval').length,
      },
      studies: {
        total: studies.length,
        inReview: studies.filter(
          (s) => s.stage === 'finance_review' || s.stage === 'waiting_approval',
        ).length,
        readyToLaunch: studies.filter((s) => s.stage === 'approved').length,
      },
      performance: {
        extraSalesSar: measured.reduce((s, p) => s + p.revenueSar, 0),
        roiPct: measured.length
          ? Math.round(measured.reduce((s, p) => s + p.roiPct, 0) / measured.length)
          : 0,
        campaignsMeasured: measured.length,
        alerts: alerts.length,
      },
      giftCards: { cards: 0, soldSar: 0, outstandingSar: 0 },
      rewards: { activeMembers: 0, pointsIssued: 0, repeatRatePct: 0 },
      alerts,
    };
  }

  /* ── gift cards and rewards ─────────────────────────────────────────── */

  giftCardProducts(): Promise<GiftCardProduct[]> {
    return this.store.listGiftCardProducts();
  }

  async saveGiftCardProduct(actor: Actor, body: unknown, id?: string): Promise<GiftCardProduct> {
    requirePrepare(actor);
    const p = GiftCardInput.safeParse(body);
    if (!p.success) throw new EngineRefusal(422, 'invalid_gift_card', firstIssue(p.error));
    if (id) {
      const exists = (await this.store.listGiftCardProducts()).some((x) => x.id === id);
      if (!exists) throw new EngineRefusal(404, 'gift_card_product_not_found');
    }
    const code = id ?? `GC-${Date.now().toString(36).toUpperCase()}`;
    const saved = await this.store.saveGiftCardProduct({ ...p.data, id: code }, !id);
    await this.log(
      actor,
      id ? 'edited' : 'prepared',
      'gift_card_product',
      code,
      `Gift card product saved: ${p.data.name.en}`,
    );
    return saved;
  }

  async giftCardStats(range: { from: string; to: string }): Promise<GiftCardStats> {
    const from = day.safeParse(range.from).success ? range.from : dayOf(this.now());
    const to = day.safeParse(range.to).success ? range.to : from;
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
    return {
      sold: 0,
      salesSar: 0,
      redeemedSar: 0,
      redemptions: 0,
      outstandingSar: 0,
      activeCards: 0,
      unusedCards: 0,
      unusedSar: 0,
      sentAsGift: 0,
      boughtForSelf: 0,
      perDay: Array.from({ length: Math.min(days, 60) }, (_, i) => ({
        day: plusDays(from, i),
        salesSar: 0,
        redeemedSar: 0,
      })),
      expiringSoon: { cards: 0, valueSar: 0, withinDays: 30 },
    };
  }

  async giftCardActivity(): Promise<GiftCardActivity[]> {
    return [];
  }

  earningRules(): Promise<EarningRule[]> {
    return this.store.listEarningRules();
  }

  async saveEarningRule(actor: Actor, body: unknown, id?: string): Promise<EarningRule> {
    requirePrepare(actor);
    const r = EarningRuleInput.safeParse(body);
    if (!r.success) throw new EngineRefusal(422, 'invalid_earning_rule', firstIssue(r.error));
    if (r.data.validTo && r.data.validTo < r.data.validFrom)
      throw new EngineRefusal(422, 'invalid_earning_rule', {
        field: 'validTo',
        message: 'before validFrom',
      });
    const rules = await this.store.listEarningRules();
    if (id && !rules.some((x) => x.id === id)) throw new EngineRefusal(404, 'rule_not_found');
    const code = id ?? `ER-${Date.now().toString(36).toUpperCase()}`;
    const saved = await this.store.saveEarningRule({ ...r.data, id: code }, !id);
    await this.log(
      actor,
      id ? 'edited' : 'prepared',
      'earning_rule',
      code,
      `Earning rule saved: ${r.data.name}`,
    );
    return saved;
  }

  async rewardsCampaigns(): Promise<RewardsCampaign[]> {
    return [];
  }
  async rewardsItems(): Promise<RewardsItem[]> {
    return [];
  }
  async rewardsStats(): Promise<RewardsStats> {
    const now = this.now();
    const perMonth = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - i), 1));
      return {
        month: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
        issued: 0,
        redeemed: 0,
        expired: 0,
      };
    });
    return {
      outstandingPoints: 0,
      outstandingSar: 0,
      issuedPoints6m: 0,
      redeemedPoints6m: 0,
      expiredPoints6m: 0,
      realCostSar: 0,
      activeMembers: 0,
      redeemingMembers: 0,
      perMonth,
      expiringSoon: { points: 0, customers: 0, withinDays: 14 },
    };
  }
  async rewardsMembers(): Promise<RewardsMember[]> {
    return [];
  }

  /* ── pre-studies ────────────────────────────────────────────────────── */

  async ordersExport(): Promise<OrdersExportRow[]> {
    return [];
  }

  async simulateCheckout(body: unknown): Promise<CheckoutSimulation> {
    const b = z
      .object({
        campaignId: z.string().max(40),
        brandId: z.string().max(64),
        orderType: z.enum(ORDER_TYPES),
        subtotalSar: z.number().min(0),
        otherOffer: z.boolean(),
        otherCoupon: z.boolean(),
        loyalty: z.boolean(),
      })
      .safeParse(body);
    if (!b.success) throw new EngineRefusal(422, 'invalid_simulation', firstIssue(b.error));
    const c = (await this.store.getCampaign(b.data.campaignId))?.campaign ?? null;
    return simulateCampaignCheckout(c, b.data);
  }

  async listStudies(): Promise<Study[]> {
    return (await this.store.listStudies()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getStudy(id: string): Promise<Study | null> {
    return this.store.getStudy(id);
  }

  /**
   * A study moves draft -> finance_review -> waiting_approval -> approved ->
   * running -> finished (or back to draft when sent back). Each move is
   * stamped HERE with who and when; a person cannot write someone else's
   * name into the review or the approval, and the creator never approves.
   */
  async saveStudy(actor: Actor, body: unknown, pathId: string): Promise<Study> {
    const parsed = StudyInput.safeParse(body);
    if (!parsed.success) throw new EngineRefusal(422, 'invalid_study', firstIssue(parsed.error));
    const s = parsed.data;
    if (s.id !== pathId)
      throw new EngineRefusal(422, 'invalid_study', {
        field: 'id',
        message: 'does not match the path',
      });
    const prev = await this.store.getStudy(s.id);
    const now = this.iso();
    if (!prev) {
      requirePrepare(actor);
      const fresh: Study = {
        ...(s as unknown as Study),
        stage: 'draft',
        createdBy: actor.id,
        createdAt: now,
        review: { by: null, at: null, note: null },
        approval: emptyApproval(),
        campaignId: null,
      };
      const saved = await this.store.insertStudy(fresh);
      await this.log(actor, 'prepared', 'study', s.id, `Pre-study created: ${s.name}`);
      return saved;
    }
    const from = prev.stage;
    const to = s.stage;
    const base: Study = {
      ...(s as unknown as Study),
      createdBy: prev.createdBy,
      createdAt: prev.createdAt,
      review: prev.review,
      approval: prev.approval,
      campaignId: prev.campaignId,
      /* What was submitted is what is reviewed and approved. */
      /* What was submitted is what is reviewed, approved and run (review
         2026-11-16): after the draft stage the content is the submitted one. */
      ...(from === 'draft'
        ? {}
        : {
            name: prev.name,
            objective: prev.objective,
            period: prev.period,
            data: prev.data,
            scenarios: prev.scenarios,
            chosenScenarioId: prev.chosenScenarioId,
          }),
    };
    let next: Study;
    let action = 'edited';
    const key = `${from}>${to}`;
    switch (key) {
      case 'draft>draft':
      case 'running>running':
      case 'finance_review>finance_review':
      case 'approved>approved':
        requirePrepare(actor);
        next = base;
        break;
      case 'draft>finance_review':
        requirePrepare(actor);
        if (!s.chosenScenarioId || !s.scenarios.some((x) => x.id === s.chosenScenarioId))
          throw new EngineRefusal(422, 'invalid_study', {
            field: 'chosenScenarioId',
            message: 'choose a scenario',
          });
        next = {
          ...base,
          approval: { ...emptyApproval(), requestedBy: actor.id, requestedAt: now },
        };
        action = 'submitted';
        break;
      case 'finance_review>waiting_approval':
        requireDecide(actor);
        if (prev.createdBy === actor.id || prev.approval.requestedBy === actor.id)
          throw new EngineRefusal(403, 'own_study');
        next = { ...base, review: { by: actor.id, at: now, note: s.review.note ?? null } };
        action = 'reviewed';
        break;
      case 'waiting_approval>approved':
      case 'waiting_approval>draft': {
        requireDecide(actor);
        if (prev.createdBy === actor.id || prev.approval.requestedBy === actor.id)
          throw new EngineRefusal(403, 'own_study');
        const approve = to === 'approved';
        next = {
          ...base,
          approval: {
            ...prev.approval,
            decidedBy: actor.id,
            decidedAt: now,
            note: s.approval.note ?? (approve ? null : 'sent back'),
          },
        };
        action = approve ? 'approved' : 'rejected';
        break;
      }
      case 'approved>running': {
        requirePrepare(actor);
        const cid = s.campaignId;
        const linked = cid ? await this.store.getCampaign(cid) : null;
        if (!linked)
          throw new EngineRefusal(422, 'invalid_study', {
            field: 'campaignId',
            message: 'unknown campaign',
          });
        next = { ...base, campaignId: cid };
        action = 'launched';
        break;
      }
      case 'running>finished':
        requirePrepare(actor);
        next = base;
        action = 'finished';
        break;
      default:
        throw new EngineRefusal(409, 'bad_transition', { from, to });
    }
    const saved = await this.store.updateStudy(next);
    await this.log(actor, action, 'study', s.id, `Pre-study ${action}: ${s.name}`);
    return saved;
  }

  async opportunities(): Promise<Opportunity[]> {
    return [];
  }

  async customerGroups(): Promise<CustomerGroup[]> {
    return [];
  }
}

/**
 * The control group: a stable share of a campaign's customers who are NOT
 * given the coupon, so the extra orders can be measured. Stable per campaign
 * and phone, so issuing the same list twice holds back the same people.
 */
export function inControlGroup(campaignId: string, phone: string, pctHeld: number): boolean {
  if (!(pctHeld > 0)) return false;
  let h = 2166136261;
  for (const ch of `${campaignId}:${phone}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 100 < pctHeld;
}
