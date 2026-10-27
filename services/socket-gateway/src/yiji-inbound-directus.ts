import { createItem, readItems, readMe, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  RULE_COUPON_LIMIT_SETTING_KEY,
  cleanContactName,
  internationalPhone,
  isPhoneDerivedCustomerId,
  parseRuleCouponLimit,
  ruleCouponCountFilter,
  type CompensationRule,
  type RuleCouponLimit,
  type StoreRecord,
} from '@yiji/shared-types';
import {
  InboundStoreError,
  type InboundCoupon,
  type InboundTicket,
  type NewCouponRow,
  type NewTicketRow,
  type YijiInboundStore,
} from './yiji-inbound.js';

/**
 * The Yiji inbound API's storage, through the gateway's Directus service
 * account (`svc-socket-gateway`). Grants it needs are in roles.ts beside that
 * role; every query names only fields that role can read, because Directus
 * refuses a WHOLE query that names one it cannot (silent-empty-failures).
 */

/** Sort a Directus SDK rejection into what it means for a retry. */
export function classifyDirectusError(err: unknown): InboundStoreError {
  if (err instanceof InboundStoreError) return err;
  const e = (err ?? {}) as {
    response?: { status?: number };
    errors?: unknown;
    message?: unknown;
  };
  const status = typeof e.response?.status === 'number' ? e.response.status : null;
  const first = Array.isArray(e.errors)
    ? (e.errors[0] as
        | { message?: string; extensions?: { code?: string; field?: string | null } }
        | undefined)
    : undefined;
  const message = String(first?.message ?? e.message ?? 'directus request failed');
  if (first?.extensions?.code === 'RECORD_NOT_UNIQUE') {
    return new InboundStoreError('duplicate', message, first.extensions.field ?? null);
  }
  if (status === null || status >= 500 || status === 408 || status === 429) {
    return new InboundStoreError('transient', message);
  }
  return new InboundStoreError('refused', message);
}

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw classifyDirectusError(err);
  }
};

const TICKET_FIELDS = [
  'id',
  'external_id',
  'status',
  'compensation',
  'contact',
  'customer_phone',
  'order_id',
  'description',
  'resolved_at',
  'date_created',
  'store.yiji_restaurant_id',
];

const COUPON_FIELDS = [
  'id',
  'external_id',
  'ticket',
  'coupon_code',
  'status',
  'decision_note',
  'decided_at',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'valid_from',
  'valid_to',
  'date_created',
];

/* Newer columns, read in their OWN best-effort query: a column not yet
   bootstrapped on an environment must not 403 the read-back as a whole. */
const COUPON_LATE_FIELDS = ['id', 'removal_status', 'replaced_by'];
/* Newer still (compensation rules, 2026-10-27): tried WITH the late fields
   first, then without - so an environment missing only this column keeps
   reading the removal state. */
const COUPON_RULE_FIELDS = ['policy_rule'];

/** Every column of a rule the matcher and the coupon read. */
const RULE_FIELDS = [
  'id',
  'name',
  'active',
  'priority',
  'complaint_type',
  'service_type',
  'min_delay_minutes',
  'min_order_value',
  'max_order_value',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'validity_days',
  'usage_limit',
  'delivery_type',
  'coupon_type',
  'issuing_side',
  'no_other_discounts',
  'date_created',
];

/** Directus may hand back decimals as strings; the matcher wants numbers. */
function toRule(r: Record<string, unknown>): CompensationRule {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    active: r.active !== false,
    priority: num(r.priority) ?? 0,
    complaint_type: String(r.complaint_type ?? ''),
    service_type: str(r.service_type),
    min_delay_minutes: num(r.min_delay_minutes),
    min_order_value: num(r.min_order_value),
    max_order_value: num(r.max_order_value),
    discount_category: String(r.discount_category ?? ''),
    coupon_value: num(r.coupon_value),
    coupon_percent: num(r.coupon_percent),
    max_discount: num(r.max_discount),
    validity_days: num(r.validity_days),
    usage_limit: num(r.usage_limit),
    delivery_type: str(r.delivery_type),
    coupon_type: str(r.coupon_type),
    issuing_side: str(r.issuing_side),
    no_other_discounts: r.no_other_discounts === true,
    date_created: str(r.date_created),
  };
}

type Ref = string | { id?: string | null } | null | undefined;
const refId = (v: Ref): string | null =>
  v == null ? null : typeof v === 'object' ? (v.id ?? null) : String(v);
const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

interface TicketRow {
  id: string;
  external_id: string | null;
  status: string | null;
  compensation: string | null;
  contact: Ref;
  customer_phone: string | null;
  order_id: string | null;
  description: string | null;
  resolved_at: string | null;
  date_created: string | null;
  store: { yiji_restaurant_id?: string | null } | string | null;
}

function toTicket(r: TicketRow): InboundTicket {
  return {
    id: String(r.id),
    externalId: str(r.external_id),
    status: str(r.status),
    compensation: str(r.compensation),
    contactId: refId(r.contact),
    customerPhone: str(r.customer_phone),
    orderId: str(r.order_id),
    description: str(r.description),
    restaurantId:
      r.store && typeof r.store === 'object' ? str(r.store.yiji_restaurant_id ?? null) : null,
    dateCreated: str(r.date_created),
    resolvedAt: str(r.resolved_at),
  };
}

type CouponRow = Record<string, unknown> & { id: string };

function toCoupon(
  r: CouponRow,
  late?: { removal_status?: unknown; replaced_by?: Ref; policy_rule?: Ref },
): InboundCoupon {
  return {
    id: String(r.id),
    externalId: str(r.external_id),
    ticketId: refId(r.ticket as Ref),
    code: str(r.coupon_code),
    status: str(r.status),
    decisionNote: str(r.decision_note),
    decidedAt: str(r.decided_at),
    value: num(r.coupon_value),
    percent: num(r.coupon_percent),
    maxDiscount: num(r.max_discount),
    validFrom: str(r.valid_from),
    validTo: str(r.valid_to),
    removalStatus: str(late?.removal_status),
    replacedBy: refId(late?.replaced_by),
    dateCreated: str(r.date_created),
    policyRule: refId(late?.policy_rule),
  };
}

export interface YijiInboundDirectusOptions {
  /** The Yiji vendor's platform id (`vendors.yiji_vendor_id`), i.e. DEFAULT_VENDOR_ID. */
  yijiVendorExternalId: string;
  /** `YIJI_INBOUND_ACTOR_USER_ID`: the "Yiji" system user. Unset = the service account itself. */
  actorUserId?: string | null;
  storesTtlMs?: number;
  /** How long the compensation rules are cached (default 60 s). */
  rulesTtlMs?: number;
}

export class YijiInboundDirectus implements YijiInboundStore {
  private vendorCache: { id: string; at: number } | null = null;
  private storesCache: { rows: StoreRecord[]; at: number } | null = null;
  private rulesCache: { rows: CompensationRule[]; at: number } | null = null;
  private actor: string | null | undefined;

  constructor(
    private readonly client: YijiDirectusClient,
    private readonly opts: YijiInboundDirectusOptions,
  ) {
    const configured = opts.actorUserId?.trim();
    this.actor = configured ? configured : undefined;
  }

  private req<T>(cmd: unknown): Promise<T> {
    return wrap(() => this.client.request(cmd as never) as Promise<T>);
  }

  async yijiVendorId(): Promise<string | null> {
    if (this.vendorCache && Date.now() - this.vendorCache.at < 5 * 60_000) {
      return this.vendorCache.id;
    }
    const rows = await this.req<Array<{ id: string }>>(
      readItems(
        'vendors' as never,
        {
          filter: {
            yiji_vendor_id: { _eq: this.opts.yijiVendorExternalId },
            status: { _eq: 'active' },
          },
          fields: ['id'],
          limit: 1,
        } as never,
      ),
    );
    const id = rows[0]?.id ? String(rows[0].id) : null;
    if (id) this.vendorCache = { id, at: Date.now() };
    return id;
  }

  async findTicket(vendor: string, externalId: string): Promise<InboundTicket | null> {
    const rows = await this.req<TicketRow[]>(
      readItems(
        'tickets' as never,
        {
          filter: { vendor: { _eq: vendor }, external_id: { _eq: externalId } },
          fields: TICKET_FIELDS,
          limit: 1,
        } as never,
      ),
    );
    return rows[0] ? toTicket(rows[0]) : null;
  }

  private async lateCouponFields(
    ids: string[],
  ): Promise<Map<string, { removal_status?: unknown; replaced_by?: Ref; policy_rule?: Ref }>> {
    const out = new Map<
      string,
      { removal_status?: unknown; replaced_by?: Ref; policy_rule?: Ref }
    >();
    if (ids.length === 0) return out;
    const read = (fields: string[]) =>
      this.req<
        Array<{ id: string; removal_status?: unknown; replaced_by?: Ref; policy_rule?: Ref }>
      >(
        readItems(
          'coupon_approvals' as never,
          {
            filter: { id: { _in: ids } },
            fields,
            limit: ids.length,
          } as never,
        ),
      );
    for (const fields of [[...COUPON_LATE_FIELDS, ...COUPON_RULE_FIELDS], COUPON_LATE_FIELDS]) {
      try {
        for (const r of await read(fields)) out.set(String(r.id), r);
        return out;
      } catch {
        /* Not bootstrapped here yet: try the older set, then read as "never
           removed / not replaced / not from a rule". */
      }
    }
    return out;
  }

  private async coupons(filter: Record<string, unknown>, limit: number): Promise<InboundCoupon[]> {
    const rows = await this.req<CouponRow[]>(
      readItems(
        'coupon_approvals' as never,
        {
          filter,
          fields: COUPON_FIELDS,
          sort: ['date_created'],
          limit,
        } as never,
      ),
    );
    const late = await this.lateCouponFields(rows.map((r) => String(r.id)));
    return rows.map((r) => toCoupon(r, late.get(String(r.id))));
  }

  async findCoupon(vendor: string, externalId: string): Promise<InboundCoupon | null> {
    const rows = await this.coupons(
      { vendor: { _eq: vendor }, external_id: { _eq: externalId } },
      1,
    );
    return rows[0] ?? null;
  }

  async couponExists(id: string): Promise<boolean> {
    const rows = await this.req<Array<{ id: string }>>(
      readItems(
        'coupon_approvals' as never,
        {
          filter: { id: { _eq: id } },
          fields: ['id'],
          limit: 1,
        } as never,
      ),
    );
    return rows.length > 0;
  }

  ticketCoupons(ticketId: string): Promise<InboundCoupon[]> {
    return this.coupons({ ticket: { _eq: ticketId } }, 100);
  }

  /** The store master, as the agent portal reads it (useStores), cached briefly. */
  async stores(): Promise<StoreRecord[]> {
    const ttl = this.opts.storesTtlMs ?? 5 * 60_000;
    if (this.storesCache && Date.now() - this.storesCache.at < ttl) return this.storesCache.rows;
    const rows = await this.req<
      Array<{
        id: string;
        code: string | null;
        name: string;
        city: string | null;
        area_manager: string | null;
        chain_manager: string | null;
        yiji_restaurant_id: string | null;
        brand: {
          code?: string | null;
          name?: string | null;
          yiji_brand_name?: string | null;
        } | null;
      }>
    >(
      readItems(
        'stores' as never,
        {
          limit: -1,
          fields: [
            'id',
            'code',
            'name',
            'city',
            'area_manager',
            'chain_manager',
            'yiji_restaurant_id',
            'brand.code',
            'brand.name',
            'brand.yiji_brand_name',
          ],
        } as never,
      ),
    );
    const mapped: StoreRecord[] = rows.map((s) => ({
      id: String(s.id),
      code: s.code,
      name: s.name,
      city: s.city,
      areaManager: s.area_manager,
      chainManager: s.chain_manager,
      brandCode: s.brand?.code ?? null,
      brandName: s.brand?.name ?? null,
      brandYijiName: s.brand?.yiji_brand_name ?? null,
      yijiRestaurantId: s.yiji_restaurant_id,
    }));
    this.storesCache = { rows: mapped, at: Date.now() };
    return mapped;
  }

  /**
   * Find the customer by phone within the vendor - in the canonical `05…`
   * form and, for rows written before the migration, `+966…` - or create
   * them. A known Yiji id is adopted onto a contact that lacks one (never
   * overwriting, never a phone-derived handle), exactly as the chat path does.
   */
  async upsertContact(
    vendor: string,
    c: { phone: string; name: string | null; yijiCustomerId: string | null },
  ): Promise<string> {
    const spellings = [
      ...new Set([c.phone, internationalPhone(c.phone)].filter(Boolean)),
    ] as string[];
    const yijiId =
      c.yijiCustomerId && !isPhoneDerivedCustomerId(c.yijiCustomerId) ? c.yijiCustomerId : null;
    const name = cleanContactName(c.name);
    const find = async () =>
      (
        await this.req<
          Array<{ id: string; name: string | null; external_customer_id: string | null }>
        >(
          readItems(
            'contacts' as never,
            {
              filter: { vendor: { _eq: vendor }, phone: { _in: spellings } },
              fields: ['id', 'name', 'external_customer_id'],
              limit: 1,
            } as never,
          ),
        )
      )[0] ?? null;

    const existing = await find();
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (yijiId && !existing.external_customer_id) patch.external_customer_id = yijiId;
      if (name && !existing.name?.trim()) patch.name = name;
      if (Object.keys(patch).length > 0) {
        try {
          await this.req(updateItem('contacts' as never, existing.id, patch as never));
        } catch {
          /* Best effort: the ticket does not depend on it. */
        }
      }
      return String(existing.id);
    }
    try {
      const created = await this.req<{ id: string }>(
        createItem(
          'contacts' as never,
          {
            vendor,
            phone: c.phone,
            name,
            external_customer_id: yijiId,
            ...(yijiId ? { acquisition_channel: 'app' } : {}),
          } as never,
        ),
      );
      return String(created.id);
    } catch (err) {
      /* A racing request created the same (vendor, phone): use theirs. */
      const raced = await find().catch(() => null);
      if (raced) return String(raced.id);
      throw classifyDirectusError(err);
    }
  }

  /** The compensation rules, cached briefly (one small read per minute at most). */
  async compensationRules(): Promise<CompensationRule[]> {
    const ttl = this.opts.rulesTtlMs ?? 60_000;
    if (this.rulesCache && Date.now() - this.rulesCache.at < ttl) return this.rulesCache.rows;
    const rows = await this.req<Array<Record<string, unknown>>>(
      readItems(
        'compensation_rules' as never,
        {
          filter: { active: { _eq: true } },
          fields: RULE_FIELDS,
          limit: -1,
        } as never,
      ),
    );
    const mapped = rows.map(toRule);
    this.rulesCache = { rows: mapped, at: Date.now() };
    return mapped;
  }

  /** The optional per-customer limit (`app_settings`); unreadable = off. */
  async ruleCouponLimit(): Promise<RuleCouponLimit | null> {
    try {
      const rows = await this.req<Array<{ value: unknown }>>(
        readItems(
          'app_settings' as never,
          {
            filter: { key: { _eq: RULE_COUPON_LIMIT_SETTING_KEY } },
            fields: ['value'],
            limit: 1,
          } as never,
        ),
      );
      return parseRuleCouponLimit(rows[0]?.value ?? null);
    } catch {
      return null;
    }
  }

  /** Rule coupons this customer got since `sinceIso` - read up to `max` rows only. */
  async ruleCouponsSince(contactId: string, sinceIso: string, max: number): Promise<number> {
    const rows = await this.req<unknown[]>(
      readItems(
        'coupon_approvals' as never,
        {
          filter: ruleCouponCountFilter(contactId, sinceIso),
          fields: ['id'],
          limit: Math.max(1, max),
        } as never,
      ),
    );
    return rows.length;
  }

  async couponCodeTaken(code: string): Promise<boolean> {
    const [a, t] = await Promise.all([
      this.req<unknown[]>(
        readItems(
          'coupon_approvals' as never,
          {
            filter: { coupon_code: { _eq: code } },
            fields: ['id'],
            limit: 1,
          } as never,
        ),
      ),
      this.req<unknown[]>(
        readItems(
          'tickets' as never,
          {
            filter: { coupon_code: { _eq: code } },
            fields: ['id'],
            limit: 1,
          } as never,
        ),
      ),
    ]);
    return a.length > 0 || t.length > 0;
  }

  async createTicket(row: NewTicketRow): Promise<void> {
    await this.req(createItem('tickets' as never, row as never));
  }

  async createCoupon(row: NewCouponRow): Promise<void> {
    await this.req(createItem('coupon_approvals' as never, row as never));
  }

  async setTicketCompensation(id: string, value: 'Compensated' | 'Not Compensated'): Promise<void> {
    await this.req(updateItem('tickets' as never, id, { compensation: value } as never));
  }

  async addTicketEvent(
    ticketId: string,
    actor: string | null,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.req(
      createItem(
        'ticket_events' as never,
        {
          ticket: ticketId,
          /* `commented`: what the ticket page renders with its text. */
          event_type: 'commented',
          ...(actor ? { actor } : {}),
          payload: { text, ...payload },
        } as never,
      ),
    );
  }

  async actorId(): Promise<string | null> {
    if (this.actor !== undefined) return this.actor;
    try {
      const me = await this.req<{ id?: string }>(readMe({ fields: ['id'] }));
      this.actor = me?.id ? String(me.id) : null;
    } catch {
      return null; // not cached: the next request asks again
    }
    return this.actor;
  }
}
