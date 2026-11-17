import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import {
  Yiji2CompensationEventJob,
  compensationEventFromYiji2,
  couponEventFromYiji2,
  parseYiji2EventsBody,
  yiji2EventsOf,
  type Yiji2EventEnvelope,
} from '@yiji/shared-types';
import SAMPLES from '../../../packages/shared-types/tests/fixtures/yiji2-compensation-samples.json';

/**
 * THE REAL V2 PAYLOADS (yiji-platform `docs/integrations/crm/auto-compensation-samples.md`,
 * printed by a V2 test run on 2026-11-18). Every sample goes the way a real
 * delivery goes: the socket gateway's parser (`parseYiji2EventsBody` +
 * `compensationEventFromYiji2`), a JSON round trip (BullMQ stores the job as
 * JSON), the processor's `Yiji2CompensationEventJob` parse, then the worker
 * job against the Directus test double. Asserts the case row, the ticket and
 * the notifications. Also: key order does not matter; the three proposals of
 * one case are an upsert in any order; a coupon case ends the same whichever
 * of `coupon.granted` / `compensation.decided` comes first.
 */
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'list', collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({
    op: 'get',
    collection,
    id,
    opts,
  }),
  createItem: (collection: string, payload: unknown) => ({ op: 'create', collection, payload }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'update',
    collection,
    id,
    payload,
  }),
  readUsers: (opts: unknown) => ({ op: 'list', collection: 'directus_users', opts }),
}));

const { processYiji2CompensationEvent } =
  await import('../src/processors/compensation-yiji2-events.js');
const { processYiji2CouponEvent } = await import('../src/processors/coupon-yiji2-events.js');

type Rec = Record<string, unknown>;
type Filter = Record<string, Rec>;
type SampleName = Exclude<keyof typeof SAMPLES, '_source'>;

const get = (r: Rec, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Rec | undefined)?.[k], r);
function matches(r: Rec, filter: Filter, prefix = ''): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const ops = Object.keys(cond);
    if (ops.length && !ops[0]!.startsWith('_')) return matches(r, cond as Filter, `${prefix}${k}.`);
    return Object.entries(cond).every(([op, val]) => {
      const v = get(r, `${prefix}${k}`);
      if (op === '_eq') return v != null && String(v) === String(val);
      if (op === '_in') return (val as unknown[]).includes(v);
      if (op === '_null') return (v == null) === val;
      if (op === '_nnull') return (v != null) === val;
      throw new Error(`fake: ${op}`);
    });
  });
}

function fakeDirectus(seed: Record<string, Rec[]> = {}) {
  const tables = new Map<string, Rec[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const table = (c: string) => {
    if (!tables.has(c)) tables.set(c, []);
    return tables.get(c)!;
  };
  let n = 0;
  const unique: Record<string, string[]> = {
    compensation_cases: ['case_id'],
    tickets: ['external_id'],
  };
  const request = vi.fn(async (cmd: Rec) => {
    const c = String(cmd.collection);
    if (cmd.op === 'list') {
      const o = (cmd.opts ?? {}) as { filter?: Filter; limit?: number };
      const rows = table(c).filter((r) => matches(r, o.filter ?? {}));
      return (o.limit && o.limit > 0 ? rows.slice(0, o.limit) : rows).map((r) => ({ ...r }));
    }
    if (cmd.op === 'get') {
      const row = table(c).find((r) => r.id === cmd.id);
      if (!row) throw new Error('not found');
      return { ...row };
    }
    if (cmd.op === 'create') {
      const p = cmd.payload as Rec;
      for (const u of unique[c] ?? [])
        if (p[u] != null && table(c).some((r) => r[u] === p[u]))
          throw new Error('RECORD_NOT_UNIQUE');
      const row = { id: `${c}-${++n}`, ...p };
      table(c).push(row);
      return { ...row };
    }
    if (cmd.op === 'update') {
      const row = table(c).find((r) => r.id === cmd.id);
      if (!row) throw new Error('not found');
      Object.assign(row, cmd.payload as Rec);
      return { ...row };
    }
    throw new Error('fake: unknown command');
  });
  return { request, tables, table };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger & Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;

const V2_VENDOR = 'vendor-v2-uuid';
const USERS = [
  { id: 'u-admin', status: 'active', role: { name: 'Administrator' } },
  { id: 'u-wa', status: 'active', role: { name: 'WeCare Admin' } },
  { id: 'u-ws', status: 'active', role: { name: 'WeCare Supervisor' } },
  { id: 'u-agent', status: 'active', role: { name: 'WeCare Agent' } },
];

function setup(seed: Record<string, Rec[]> = {}) {
  const d = fakeDirectus({ directus_users: USERS, ...seed });
  const notifications = { add: vi.fn(async () => ({ id: 'n' })) };
  const deps = {
    directus: d as never,
    logger,
    notificationsQueue: notifications,
    vendorOf: async (key: string) => (key === 'yiji2:2' ? { id: V2_VENDOR } : null),
  };
  return { d, notifications, deps };
}

let seq = 0;
/** A sample's envelope with a unique id (the doc prints `<event uuid>`). */
function envelope(name: SampleName): Rec {
  const e = structuredClone(SAMPLES[name]) as Rec;
  e.id = `sample-${name}-${++seq}`;
  return e;
}

/** Every key of every object reversed: the CRM must not depend on key order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Rec)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  return v;
}

/** The socket gateway's parse of one delivered body -> the envelopes. */
function received(body: unknown): Yiji2EventEnvelope[] {
  const parsed = parseYiji2EventsBody(JSON.parse(JSON.stringify(body)));
  expect(parsed.success).toBe(true);
  return yiji2EventsOf(parsed.data!);
}

/** gateway parser -> job -> JSON (BullMQ) -> the processor's parse. */
function jobOf(e: Yiji2EventEnvelope): Yiji2CompensationEventJob {
  const malformed = vi.fn();
  const job = compensationEventFromYiji2(e, 'yiji2:2', { malformed });
  expect(malformed).not.toHaveBeenCalled();
  expect(job).not.toBeNull();
  return Yiji2CompensationEventJob.parse(JSON.parse(JSON.stringify(job)));
}

type Deps = ReturnType<typeof setup>['deps'];
async function deliver(names: SampleName[], deps: Deps, opts: { reversed?: boolean } = {}) {
  const out: string[] = [];
  for (const name of names) {
    const body = opts.reversed ? reverseKeys(envelope(name)) : envelope(name);
    for (const e of received(body)) {
      const coupon = couponEventFromYiji2(e, 'yiji2:2');
      if (coupon) out.push(await processYiji2CouponEvent(coupon, deps as never));
      if (e.type.startsWith('compensation.'))
        out.push(await processYiji2CompensationEvent(jobOf(e), deps));
    }
  }
  return out;
}

const caseRow = (d: ReturnType<typeof fakeDirectus>, caseId: string) =>
  d.table('compensation_cases').find((r) => r.case_id === caseId)!;
const ticketOf = (d: ReturnType<typeof fakeDirectus>, caseId: string) =>
  d.table('tickets').find((t) => t.id === caseRow(d, caseId).ticket)!;
const recipients = (n: { add: ReturnType<typeof vi.fn> }) =>
  n.add.mock.calls.map((c) => ((c as unknown[])[1] as Rec).recipientId).sort();

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('every V2 sample parses at the gateway (no sample is malformed)', () => {
  const names = Object.keys(SAMPLES).filter((k) => k !== '_source') as SampleName[];
  it.each(names)('%s', (name) => {
    const [e] = received(envelope(name));
    const job = jobOf(e!);
    expect(job.type).toBe(SAMPLES[name].type);
    expect(job.data).toEqual(SAMPLES[name].data);
    expect(job.at).toBe('2026-11-17T21:57:45.610701Z');
  });
  it('the decided samples carry order_number; one without it is still accepted and matched by case_id', async () => {
    for (const n of [
      'decided_2_1_approved_wallet',
      'decided_2_2_approved_coupon',
      'decided_2_3_rejected',
    ] as const)
      expect(SAMPLES[n].data.order_number).toBeTypeOf('number');
    const { d, deps } = setup();
    await deliver(['proposed_1_1_auto_late_delivery'], deps);
    const e = envelope('decided_2_1_approved_wallet');
    delete (e.data as Rec).order_number;
    const [parsed] = received(e);
    expect(await processYiji2CompensationEvent(jobOf(parsed!), deps)).toBe('case-updated');
    expect(caseRow(d, '1')).toMatchObject({
      status: 'approved',
      wallet_entry_id: '1',
      order_number: '2611000500001',
    });
    expect(d.table('tickets')).toHaveLength(1);
  });
});

describe('each sample -> the case row, the ticket, the notifications', () => {
  it('1.1 auto late delivery: proposed, SAR 20.00 wallet, 16 minutes, one ticket', async () => {
    const { d, deps } = setup();
    expect(await deliver(['proposed_1_1_auto_late_delivery'], deps)).toEqual(['case-created']);
    expect(caseRow(d, '1')).toMatchObject({
      vendor: V2_VENDOR,
      status: 'proposed',
      source: 'auto',
      row_key: 'DLY-T2',
      rule_code: 'DLY',
      policy_version: 1,
      action_type: 'FIXED',
      comp_method: 'Monetary',
      amount_minor: 2000,
      currency: 'SAR',
      metric_minutes: 16,
      has_photos: false,
      order_number: '2611000500001',
      customer_id: '1',
      country: 'SA',
      brand_id: '1',
      order_total_minor: 8000,
      order_currency: 'SAR',
      expires_at: '2026-11-20T21:57:45.610Z',
    });
    expect(d.table('tickets')).toHaveLength(1);
    expect(ticketOf(d, '1')).toMatchObject({
      vendor: V2_VENDOR,
      external_id: 'compensation-case:1',
      order_id: '2611000500001',
      compensation: 'Initial',
      priority: 'medium',
      complaint_source: 'Yiji',
    });
    expect(String(ticketOf(d, '1').description)).toContain('SAR 20.00');
  });

  it('1.2 agent complaint: proposed coupon SAR 5.00, occurrence 1, logged_by_agent kept', async () => {
    const { d, deps } = setup();
    await deliver(['proposed_1_2_agent_complaint'], deps);
    expect(caseRow(d, '2')).toMatchObject({
      status: 'proposed',
      source: 'agent',
      row_key: 'KID-O1',
      occurrence: 1,
      action_type: 'COUPON_FIXED',
      comp_method: 'Discount coupon',
      amount_minor: 500,
      logged_by_agent: 'agent-7',
    });
    expect(d.table('tickets')).toHaveLength(1);
  });

  it('1.2 agent complaint the gateway already recorded: updates that row on the agent’s ticket, no second ticket', async () => {
    const { d, deps } = setup({
      tickets: [{ id: 'T-agent', vendor: V2_VENDOR }],
      compensation_cases: [{ id: 'cc-1', case_id: '2', ticket: 'T-agent', status: 'proposed' }],
    });
    expect(
      await deliver(['proposed_1_2_agent_complaint'], { ...deps, mayWaitForGateway: true } as Deps),
    ).toEqual(['case-updated']);
    expect(d.table('tickets')).toHaveLength(1);
    expect(caseRow(d, '2')).toMatchObject({ ticket: 'T-agent', amount_minor: 500 });
  });

  it('1.2 / 1.4 not yet recorded by the gateway: the job waits (BullMQ retries) instead of opening a ticket', async () => {
    const { d, deps } = setup();
    for (const n of ['proposed_1_2_agent_complaint', 'proposed_1_4_agent_with_photos'] as const)
      await expect(deliver([n], { ...deps, mayWaitForGateway: true } as Deps)).rejects.toThrow(
        /not recorded by the gateway/,
      );
    expect(d.table('tickets')).toHaveLength(0);
    expect(d.table('compensation_cases')).toHaveLength(0);
  });

  it('1.3 held for photos, then has_photos, then proposed: ONE row, ONE ticket, ends proposed SAR 15.00', async () => {
    const { d, deps } = setup();
    const out = await deliver(
      ['proposed_1_3a_held_no_photos', 'proposed_1_3b_held_has_photos'],
      deps,
    );
    expect(out).toEqual(['case-created', 'case-updated']);
    expect(caseRow(d, '3')).toMatchObject({ status: 'evidence_hold', has_photos: true });
    expect(caseRow(d, '3').amount_minor).toBeUndefined();
    await deliver(['proposed_1_3c_photos_confirmed'], deps);
    expect(d.table('compensation_cases')).toHaveLength(1);
    expect(d.table('tickets')).toHaveLength(1);
    expect(caseRow(d, '3')).toMatchObject({
      status: 'proposed',
      has_photos: true,
      amount_minor: 1500,
      currency: 'SAR',
      action_type: 'ITEM_VALUE',
      source: 'app',
      order_total_minor: 9000,
    });
  });

  it('1.4 agent complaint with photos: proposed at once, SAR 30.00', async () => {
    const { d, deps } = setup();
    await deliver(['proposed_1_4_agent_with_photos'], deps);
    expect(caseRow(d, '4')).toMatchObject({
      status: 'proposed',
      has_photos: true,
      amount_minor: 3000,
      logged_by_agent: 'agent-7',
    });
  });

  it('2.1 approved wallet credit (after 1.1): approved, issued SAR 20.00, wallet entry 1, ticket Compensated', async () => {
    const { d, deps } = setup();
    await deliver(['proposed_1_1_auto_late_delivery', 'decided_2_1_approved_wallet'], deps);
    expect(caseRow(d, '1')).toMatchObject({
      status: 'approved',
      decided_by: 'agent-17',
      decision_reason: 'checked with the branch',
      calculated_minor: 2000,
      issued_minor: 2000,
      issued_currency: 'SAR',
      overridden: false,
      wallet_entry_id: '1',
      amount_minor: 2000,
      decided_at: '2026-11-17T21:57:45.610Z',
    });
    expect(ticketOf(d, '1').compensation).toBe('Compensated');
    expect(d.table('tickets')).toHaveLength(1);
  });

  it('2.2 approved coupon with no earlier proposal (case 6): a row and a ticket from the decision alone', async () => {
    const { d, deps } = setup();
    expect(await deliver(['decided_2_2_approved_coupon'], deps)).toEqual(['case-created']);
    expect(caseRow(d, '6')).toMatchObject({
      status: 'approved',
      row_key: 'CUT-O1',
      issued_minor: 500,
      coupon_id: '1',
      grant_id: '1',
      order_number: '2611000500006',
    });
    expect(ticketOf(d, '6')).toMatchObject({
      external_id: 'compensation-case:6',
      compensation: 'Compensated',
      order_id: '2611000500006',
    });
  });

  it('2.3 rejected (after 1.2): rejected, nothing issued, ticket Not Compensated', async () => {
    const { d, deps } = setup();
    await deliver(['proposed_1_2_agent_complaint', 'decided_2_3_rejected'], deps);
    expect(caseRow(d, '2')).toMatchObject({
      status: 'rejected',
      decision_reason: 'the toy was in the bag',
      calculated_minor: 500,
      decided_by: 'agent-17',
    });
    expect(caseRow(d, '2').issued_minor).toBeUndefined();
    expect(ticketOf(d, '2').compensation).toBe('Not Compensated');
  });

  it('3 escalating case: proposed (high priority ticket), then escalated -> WeCare Supervisor + Administrator', async () => {
    const { d, deps, notifications } = setup();
    const out = await deliver(['proposed_3_escalating_case', 'escalated_3'], deps);
    expect(out).toEqual(['case-created', 'escalation-sent']);
    expect(d.table('tickets')).toHaveLength(1);
    expect(ticketOf(d, '5').priority).toBe('high');
    expect(caseRow(d, '5')).toMatchObject({
      status: 'proposed',
      amount_minor: 25000,
      action_type: 'FULL_ORDER',
      escalate_to: 'Operations Manager',
      escalation_condition: 'order_total > 200',
      escalation_condition_known: true,
      escalated_at: '2026-11-17T21:57:45.610Z',
    });
    /* "Operations Manager" -> WeCare Supervisor; the Administrator always. */
    expect(recipients(notifications)).toEqual(['u-admin', 'u-ws']);
    const n = notifications.add.mock.calls[0]![1] as Rec;
    expect(n).toMatchObject({ type: 'escalation', link: `/tickets/${ticketOf(d, '5').id}` });
    expect(String(n.body)).toContain('SAR 250.00');
  });

  it('3 escalated before its proposal: one row, one ticket, status proposed, told once', async () => {
    const { d, deps, notifications } = setup();
    await deliver(['escalated_3', 'proposed_3_escalating_case'], deps);
    expect(d.table('tickets')).toHaveLength(1);
    expect(d.table('compensation_cases')).toHaveLength(1);
    expect(caseRow(d, '5')).toMatchObject({ status: 'proposed', amount_minor: 25000 });
    expect(recipients(notifications)).toEqual(['u-admin', 'u-ws']);
  });
});

/** The whole V2 run, in the doc's order. */
const RUN: SampleName[] = [
  'proposed_1_1_auto_late_delivery',
  'proposed_1_2_agent_complaint',
  'proposed_1_3a_held_no_photos',
  'proposed_1_3b_held_has_photos',
  'proposed_1_3c_photos_confirmed',
  'proposed_1_4_agent_with_photos',
  'decided_2_1_approved_wallet',
  'decided_2_2_approved_coupon',
  'decided_2_3_rejected',
  'proposed_3_escalating_case',
  'escalated_3',
];

function snapshot(d: ReturnType<typeof fakeDirectus>) {
  const strip = (r: Rec) => {
    const { id: _id, ticket: _t, ...rest } = r;
    return rest;
  };
  return {
    cases: Object.fromEntries(
      d.table('compensation_cases').map((r) => [r.case_id, { ...strip(r) }]),
    ),
    tickets: Object.fromEntries(
      d
        .table('tickets')
        .map((t) => [
          t.external_id,
          { compensation: t.compensation, priority: t.priority, order_id: t.order_id },
        ]),
    ),
  };
}

describe('the whole V2 run (11 events)', () => {
  it('ends with six cases, six tickets, each in its right state', async () => {
    const { d, deps, notifications } = setup();
    await deliver(RUN, deps);
    expect(d.table('compensation_cases')).toHaveLength(6);
    expect(d.table('tickets')).toHaveLength(6);
    const status = Object.fromEntries(
      d.table('compensation_cases').map((r) => [r.case_id, r.status]),
    );
    expect(status).toEqual({
      '1': 'approved',
      '2': 'rejected',
      '3': 'proposed',
      '4': 'proposed',
      '5': 'proposed',
      '6': 'approved',
    });
    const comp = Object.fromEntries(
      ['1', '2', '3', '4', '5', '6'].map((c) => [c, ticketOf(d, c).compensation]),
    );
    expect(comp).toEqual({
      '1': 'Compensated',
      '2': 'Not Compensated',
      '3': 'Initial',
      '4': 'Initial',
      '5': 'Initial',
      '6': 'Compensated',
    });
    expect(recipients(notifications)).toEqual(['u-admin', 'u-ws']);
  });

  it('does not depend on JSON key order (every object’s keys reversed: same result)', async () => {
    const a = setup();
    await deliver(RUN, a.deps);
    const b = setup();
    await deliver(RUN, b.deps, { reversed: true });
    expect(snapshot(b.d)).toEqual(snapshot(a.d));
  });

  it('a redelivery of the whole run changes nothing and opens nothing', async () => {
    const { d, deps } = setup();
    await deliver(RUN, deps);
    const before = snapshot(d);
    await deliver(RUN, deps);
    expect(snapshot(d)).toEqual(before);
    expect(d.table('tickets')).toHaveLength(6);
  });
});

describe('UPSERT: compensation.proposed up to 3 times for one case_id (1.3)', () => {
  const THREE: SampleName[] = [
    'proposed_1_3a_held_no_photos',
    'proposed_1_3b_held_has_photos',
    'proposed_1_3c_photos_confirmed',
  ];
  const perms = (xs: SampleName[]): SampleName[][] =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) => perms(xs.filter((_, j) => j !== i)).map((p) => [x, ...p]));

  it.each(perms(THREE).map((p) => [p.map((n) => n.slice(-14)).join(' > '), p] as const))(
    'in order %s: one row, one ticket, ends proposed SAR 15.00 with photos',
    async (_label, order) => {
      const { d, deps } = setup();
      await deliver(order, deps);
      expect(d.table('compensation_cases')).toHaveLength(1);
      expect(d.table('tickets')).toHaveLength(1);
      expect(caseRow(d, '3')).toMatchObject({
        status: 'proposed',
        has_photos: true,
        amount_minor: 1500,
        currency: 'SAR',
      });
    },
  );

  it('a decided case is never moved back by any of the three, in any order', async () => {
    const decided = (status: 'approved' | 'rejected') => {
      const e = envelope('decided_2_3_rejected');
      Object.assign(e.data as Rec, { case_id: 3, decision: status, row_key: 'PRD-1-ALL' });
      if (status === 'approved')
        Object.assign(e.data as Rec, {
          issued: { currency: 'SAR', amount_minor: 1500 },
          wallet_entry_id: 9,
        });
      return e;
    };
    for (const status of ['approved', 'rejected'] as const) {
      const { d, deps } = setup();
      await deliver(THREE, deps);
      for (const e of received(decided(status)))
        await processYiji2CompensationEvent(jobOf(e), deps);
      await deliver([...THREE].reverse(), deps);
      await deliver(THREE, deps);
      expect(caseRow(d, '3').status).toBe(status);
      expect(ticketOf(d, '3').compensation).toBe(
        status === 'approved' ? 'Compensated' : 'Not Compensated',
      );
      expect(d.table('tickets')).toHaveLength(1);
      expect(d.table('compensation_cases')).toHaveLength(1);
    }
  });
});

describe('ORDERING: coupon.granted and compensation.decided of a coupon case (2.2)', () => {
  /**
   * V2 writes the grant's `coupon.granted` BEFORE the case's
   * `compensation.decided` (samples doc, section 2 note: sequence 14 then 15).
   * A compensation grant is made for an existing customer, so it carries no
   * `pending_grant_id` (crm-events-v1.yaml CouponEvent): the pending-grants
   * handler must not touch any CRM coupon. Built from the CouponEvent schema
   * with the ids of sample 2.2 (grant 1, coupon 1, customer 1).
   */
  const couponGranted = () => ({
    id: `granted-${++seq}`,
    type: 'coupon.granted',
    occurred_at: '2026-11-17T21:57:45.610701Z',
    environment: 'dev',
    data: {
      coupon_id: 1,
      grant_id: 1,
      code: 'COMP-6',
      customer_id: 1,
      status: 'active',
      coupon_status: 'active',
      source: 'system',
      by: { kind: 'system' },
      at: '2026-11-17T21:57:45.610701Z',
    },
  });
  /* A CRM pending-grant coupon whose V2 ids collide with sample 2.2's (both
     test databases start at 1): it must stay untouched. */
  const crmCoupon = {
    id: 'ca-1',
    status: 'approved',
    coupon_code: 'CRM-1',
    customer_phone: '+966500000001',
    yiji_coupon_id: '1',
    yiji_pending_grant_id: '1',
    yiji_coupon_user_id: null,
  };

  async function run(first: 'granted' | 'decided') {
    const { d, deps } = setup({ coupon_approvals: [crmCoupon] });
    const bodies: Rec[] =
      first === 'granted'
        ? [couponGranted(), envelope('decided_2_2_approved_coupon')]
        : [envelope('decided_2_2_approved_coupon'), couponGranted()];
    const outcomes: string[] = [];
    for (const body of bodies)
      for (const e of received(body)) {
        const coupon = couponEventFromYiji2(e, 'yiji2:2');
        if (coupon) outcomes.push(await processYiji2CouponEvent(coupon, deps as never));
        if (e.type.startsWith('compensation.'))
          outcomes.push(await processYiji2CompensationEvent(jobOf(e), deps));
      }
    return { d, outcomes };
  }

  it.each(['granted', 'decided'] as const)(
    '%s first: the case ends approved with grant 1 / coupon 1, and no CRM coupon is touched',
    async (first) => {
      const { d, outcomes } = await run(first);
      /* Only the compensation job ran: coupon.granted without pending_grant_id is not the pending-grants handler's. */
      expect(outcomes).toEqual(['case-created']);
      expect(caseRow(d, '6')).toMatchObject({
        status: 'approved',
        grant_id: '1',
        coupon_id: '1',
        issued_minor: 500,
      });
      expect(ticketOf(d, '6').compensation).toBe('Compensated');
      expect(d.table('coupon_approvals')).toEqual([crmCoupon]);
    },
  );

  it('both orders end in the same state', async () => {
    const a = await run('granted');
    const b = await run('decided');
    expect(snapshot(b.d)).toEqual(snapshot(a.d));
  });
});
