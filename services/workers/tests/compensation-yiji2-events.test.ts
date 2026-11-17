import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import {
  COMPENSATION_ESCALATION_SETTING_KEY,
  MockYiji2Transport,
  Yiji2CompensationEventJob,
  compensationCasesOf,
  compensationEventFromYiji2,
  Yiji2Connector,
} from '@yiji/shared-types';

/**
 * YIJI V2 COMPENSATION EVENTS - the workers' job (owner, 18 Nov 2026).
 * proposed -> the case row + ONE ticket; decided -> the decision, the issued
 * ids, the ticket's Compensation; escalated -> the mapped roles are told (by
 * role NAME; nobody -> the Administrator; still nobody -> an error). Idempotent
 * and order-safe. No V2 call.
 */
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'list', collection, opts }),
  createItem: (collection: string, payload: unknown) => ({ op: 'create', collection, payload }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'update',
    collection,
    id,
    payload,
  }),
  readUsers: (opts: unknown) => ({ op: 'list', collection: 'directus_users', opts }),
}));

const { processYiji2CompensationEvent, caseTicketText } =
  await import('../src/processors/compensation-yiji2-events.js');

type Rec = Record<string, unknown>;
type Filter = Record<string, Rec>;
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
  const unique: Record<string, string[]> = { compensation_cases: ['case_id'] };
  const request = vi.fn(async (cmd: Rec) => {
    const c = String(cmd.collection);
    if (cmd.op === 'list') {
      const o = (cmd.opts ?? {}) as { filter?: Filter; limit?: number };
      const rows = table(c).filter((r) => matches(r, o.filter ?? {}));
      return (o.limit && o.limit > 0 ? rows.slice(0, o.limit) : rows).map((r) => ({ ...r }));
    }
    if (cmd.op === 'create') {
      const p = cmd.payload as Rec;
      for (const u of unique[c] ?? [])
        if (table(c).some((r) => r[u] === p[u])) throw new Error('RECORD_NOT_UNIQUE');
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
  { id: 'u-ops', status: 'active', role: { name: 'Operations' } },
  { id: 'u-agent', status: 'active', role: { name: 'WeCare Agent' } },
  { id: 'u-gone', status: 'suspended', role: { name: 'WeCare Admin' } },
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

const job = (type: string, data: Rec, at = '2026-11-18T10:00:00Z', id = `e-${Math.random()}`) =>
  Yiji2CompensationEventJob.parse({ type, eventId: id, vendorKey: 'yiji2:2', at, data });

const proposedData = (over: Rec = {}) => ({
  case_id: 900001,
  status: 'proposed',
  source: 'auto',
  row_key: 'DLY-T2',
  rule_code: 'DLY',
  order_number: 2611000000001,
  customer_id: 2000000001,
  country: 'SA',
  order_total: { amount_minor: 9200, currency: 'SAR' },
  action_type: 'FIXED',
  comp_method: 'Monetary',
  amount: { amount_minor: 2000, currency: 'SAR' },
  metric_minutes: 38,
  has_photos: false,
  expires_at: '2026-11-21T10:00:00Z',
  ...over,
});

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('compensation.proposed', () => {
  it('creates the case row and ONE v2 ticket, linked to the v2 contact', async () => {
    const { d, deps } = setup({
      contacts: [
        {
          id: 'k-v2',
          vendor: V2_VENDOR,
          external_customer_id: '2000000001',
          phone: '+966500000001',
        },
        { id: 'k-v1', vendor: 'vendor-v1', external_customer_id: '2000000001', phone: '0500' },
      ],
    });
    const out = await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData()),
      deps,
    );
    expect(out).toBe('case-created');
    const tickets = d.table('tickets');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      vendor: V2_VENDOR,
      external_id: 'compensation-case:900001',
      order_id: '2611000000001',
      contact: 'k-v2',
      customer_phone: '+966500000001',
      complaint_source: 'Yiji',
      compensation: 'Initial',
      status: 'pending',
      priority: 'medium',
    });
    expect(String(tickets[0]!.subject)).toContain('DLY-T2');
    const cases = d.table('compensation_cases');
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      case_id: '900001',
      vendor: V2_VENDOR,
      ticket: tickets[0]!.id,
      status: 'proposed',
      amount_minor: 2000,
      currency: 'SAR',
      metric_minutes: 38,
      expires_at: '2026-11-21T10:00:00.000Z',
      last_event_at: '2026-11-18T10:00:00.000Z',
    });
  });

  it('a redelivery or a later update touches the same row and ticket (idempotent)', async () => {
    const { d, deps } = setup();
    await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData({ status: 'evidence_hold' })),
      deps,
    );
    await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData(), '2026-11-18T11:00:00Z'),
      deps,
    );
    expect(d.table('tickets')).toHaveLength(1);
    expect(d.table('compensation_cases')).toHaveLength(1);
    expect(d.table('compensation_cases')[0]!.status).toBe('proposed');
  });

  it('an OLDER proposal never moves the case back (held after proposed)', async () => {
    const { d, deps } = setup();
    await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData(), '2026-11-18T11:00:00Z'),
      deps,
    );
    await processYiji2CompensationEvent(
      job(
        'compensation.proposed',
        proposedData({ status: 'evidence_hold' }),
        '2026-11-18T10:00:00Z',
      ),
      deps,
    );
    expect(d.table('compensation_cases')[0]).toMatchObject({
      status: 'proposed',
      last_event_at: '2026-11-18T11:00:00.000Z',
    });
  });

  it('an agent-logged case waits for the gateway instead of opening a second ticket', async () => {
    const { d, deps } = setup();
    await expect(
      processYiji2CompensationEvent(
        job('compensation.proposed', proposedData({ logged_by_agent: 'u-agent', source: 'agent' })),
        { ...deps, mayWaitForGateway: true },
      ),
    ).rejects.toThrow(/gateway/);
    expect(d.table('tickets')).toHaveLength(0);
    /* once the gateway recorded it on the agent's ticket, the event updates that row */
    d.table('compensation_cases').push({
      id: 'row-gw',
      case_id: '900001',
      ticket: 't-agent',
      status: 'proposed',
      vendor: V2_VENDOR,
    });
    const out = await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData({ logged_by_agent: 'u-agent', source: 'agent' })),
      { ...deps, mayWaitForGateway: true },
    );
    expect(out).toBe('case-updated');
    expect(d.table('tickets')).toHaveLength(0);
    expect(d.table('compensation_cases')[0]!.ticket).toBe('t-agent');
  });

  it('after the last wait it opens the ticket itself (never lost)', async () => {
    const { d, deps } = setup();
    await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData({ logged_by_agent: 'u-agent' })),
      { ...deps, mayWaitForGateway: false },
    );
    expect(d.table('tickets')).toHaveLength(1);
  });

  it('a vendor key with no v2 vendor row is logged and not recorded', async () => {
    const { d, deps } = setup();
    const out = await processYiji2CompensationEvent(
      Yiji2CompensationEventJob.parse({
        type: 'compensation.proposed',
        eventId: 'x',
        vendorKey: 'yiji2:99',
        at: '2026-11-18T10:00:00Z',
        data: proposedData(),
      }),
      deps,
    );
    expect(out).toBe('no-vendor');
    expect(d.table('tickets')).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('compensation.decided', () => {
  it('records the decision and the issued ids; the ticket becomes Compensated', async () => {
    const { d, deps } = setup();
    await processYiji2CompensationEvent(job('compensation.proposed', proposedData()), deps);
    const out = await processYiji2CompensationEvent(
      job(
        'compensation.decided',
        {
          case_id: 900001,
          order_number: 2611000000001,
          decision: 'approved',
          by: { kind: 'partner_client', id: 'crm' },
          agent_id: 'u-agent',
          reason: 'late, fair',
          calculated: { amount_minor: 2000, currency: 'SAR' },
          issued: { amount_minor: 1500, currency: 'SAR' },
          overridden: true,
          wallet_entry_id: 950001,
          at: '2026-11-18T11:00:00Z',
        },
        '2026-11-18T11:00:00Z',
      ),
      deps,
    );
    expect(out).toBe('case-updated');
    expect(d.table('compensation_cases')[0]).toMatchObject({
      status: 'approved',
      decided_by: 'u-agent',
      decision_reason: 'late, fair',
      calculated_minor: 2000,
      issued_minor: 1500,
      overridden: true,
      wallet_entry_id: '950001',
    });
    expect(d.table('tickets')[0]!.compensation).toBe('Compensated');
  });

  it('a coupon case keeps coupon and grant; failed / rejected / expired -> Not Compensated', async () => {
    for (const decision of ['failed', 'rejected', 'expired']) {
      const { d, deps } = setup();
      await processYiji2CompensationEvent(job('compensation.proposed', proposedData()), deps);
      await processYiji2CompensationEvent(
        job(
          'compensation.decided',
          {
            case_id: 900001,
            order_number: 1,
            decision,
            by: { kind: decision === 'expired' ? 'system' : 'partner_client' },
            ...(decision === 'failed' ? { failure: 'COUPON_CHECK_REFUSED' } : {}),
          },
          '2026-11-18T12:00:00Z',
        ),
        deps,
      );
      expect(d.table('compensation_cases')[0]!.status).toBe(decision);
      expect(d.table('tickets')[0]!.compensation).toBe('Not Compensated');
      if (decision === 'failed')
        expect(d.table('compensation_cases')[0]!.failure).toBe('COUPON_CHECK_REFUSED');
      if (decision === 'expired')
        expect(d.table('compensation_cases')[0]!.decided_by).toBe('system');
    }
    const { d, deps } = setup();
    await processYiji2CompensationEvent(
      job('compensation.decided', {
        case_id: 900005,
        order_number: 2611000000001,
        decision: 'approved',
        coupon_id: 500001,
        grant_id: 700001,
      }),
      deps,
    );
    /* decided before proposed: the row and the ticket are made from it */
    expect(d.table('compensation_cases')[0]).toMatchObject({
      status: 'approved',
      coupon_id: '500001',
      grant_id: '700001',
    });
    expect(d.table('tickets')).toHaveLength(1);
  });

  it('a late proposal after the decision never reopens the case', async () => {
    const { d, deps } = setup();
    await processYiji2CompensationEvent(
      job(
        'compensation.decided',
        { case_id: 900001, order_number: 1, decision: 'rejected' },
        '2026-11-18T09:00:00Z',
      ),
      deps,
    );
    await processYiji2CompensationEvent(
      job('compensation.proposed', proposedData(), '2026-11-18T11:00:00Z'),
      deps,
    );
    expect(d.table('compensation_cases')[0]!.status).toBe('rejected');
  });
});

describe('compensation.escalated', () => {
  const escalated = (to: string) =>
    job('compensation.escalated', {
      case_id: 900002,
      row_key: 'FOREIGN-O1',
      rule_code: 'FOREIGN',
      escalate_to: to,
      condition: 'order_total > 200',
      condition_known: true,
      order_number: 2611000000001,
      customer_id: 2000000001,
      country: 'SA',
      order_total: { amount_minor: 25000, currency: 'SAR' },
    });

  it('tells every ACTIVE user of the default manager roles, by role name, linking the ticket', async () => {
    const { d, deps, notifications } = setup();
    const out = await processYiji2CompensationEvent(escalated('Operations Manager'), deps);
    expect(out).toBe('escalation-sent');
    const told = notifications.add.mock.calls.map((c) => (c as unknown[])[1] as Rec);
    expect(told.map((n) => n.recipientId).sort()).toEqual(['u-admin', 'u-wa']);
    const ticket = d.table('tickets')[0]!;
    expect(ticket.priority).toBe('high');
    expect(told[0]).toMatchObject({
      type: 'escalation',
      link: `/tickets/${ticket.id}`,
      payload: { kind: 'compensation_escalated', caseId: '900002' },
    });
    expect(String(told[0]!.title)).toContain('Operations Manager');
    expect(String(told[0]!.body)).toContain('SAR 250.00');
    const ids = notifications.add.mock.calls.map((c) => ((c as unknown[])[2] as Rec).jobId);
    expect(ids).toContain('compensation-escalated-900002-u-admin');
    expect(d.table('compensation_cases')[0]).toMatchObject({
      escalate_to: 'Operations Manager',
      escalation_condition: 'order_total > 200',
    });
  });

  it('follows the Administrator’s mapping (app_settings)', async () => {
    const { deps, notifications } = setup({
      app_settings: [
        {
          id: 's1',
          key: COMPENSATION_ESCALATION_SETTING_KEY,
          value: JSON.stringify({ 'Operations Manager': ['Operations'] }),
        },
      ],
    });
    await processYiji2CompensationEvent(escalated('Operations Manager'), deps);
    expect(
      notifications.add.mock.calls.map((c) => ((c as unknown[])[1] as Rec).recipientId),
    ).toEqual(['u-ops']);
  });

  it('mapped roles with nobody active -> the Administrator is told (never nobody)', async () => {
    const { deps, notifications } = setup({
      app_settings: [
        {
          id: 's1',
          key: COMPENSATION_ESCALATION_SETTING_KEY,
          value: { 'Relevant management': ['Area Manager'] },
        },
      ],
    });
    const out = await processYiji2CompensationEvent(escalated('Relevant management'), deps);
    expect(out).toBe('escalation-sent');
    expect(
      notifications.add.mock.calls.map((c) => ((c as unknown[])[1] as Rec).recipientId),
    ).toEqual(['u-admin']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still nobody -> an error log, no notification', async () => {
    const d = fakeDirectus({ directus_users: [] });
    const notifications = { add: vi.fn() };
    const out = await processYiji2CompensationEvent(escalated('Operations Manager'), {
      directus: d as never,
      logger,
      notificationsQueue: notifications,
      vendorOf: async () => ({ id: V2_VENDOR }),
    });
    expect(out).toBe('escalation-no-recipient');
    expect(notifications.add).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('end to end with the mock (V2 events -> the job)', () => {
  it('a mock complaint, escalation and approval land on one row and one ticket', async () => {
    const t = new MockYiji2Transport({ now: () => Date.parse('2026-11-18T10:00:00Z') });
    const api = compensationCasesOf(
      new Yiji2Connector(
        { crmId: 'v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
        { platform: 'yiji2', mock: true },
        { transport: t },
      ),
    )!;
    const c = await api.logComplaint(
      { order_number: '2611000000001', category: 'HOS', agent_id: 'u-agent', has_photos: true },
      'k1',
    );
    await api.approve(String(c.id), { agent_id: 'u-agent', reason: 'ok' }, 'k2');
    const { d, deps, notifications } = setup();
    for (const e of t.events) {
      const j = compensationEventFromYiji2(e as never, 'yiji2:2');
      if (j) await processYiji2CompensationEvent(j, deps);
    }
    expect(d.table('compensation_cases')).toHaveLength(1);
    expect(d.table('tickets')).toHaveLength(1);
    expect(d.table('compensation_cases')[0]).toMatchObject({
      status: 'approved',
      escalate_to: 'Relevant management',
    });
    expect(notifications.add).toHaveBeenCalled();
  });
});

describe('ticket text', () => {
  it('names the rule, the order and the amount', () => {
    const tx = caseTicketText('9', {
      row_key: 'HAIR-O2',
      occurrence: 2,
      order_number: '2611000000001',
      action_type: 'FIXED',
      amount_minor: 2500,
      currency: 'SAR',
    });
    expect(tx.subject).toBe('V2 compensation HAIR-O2 - order 2611000000001');
    expect(tx.description).toContain('SAR 25.00');
    expect(tx.description).toContain('occurrence 2');
  });
});
