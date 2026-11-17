import { describe, expect, it, vi } from 'vitest';
import {
  COMPENSATION_ESCALATION_TARGETS,
  DEFAULT_COMPENSATION_ESCALATION_ROLES,
  COMPENSATION_ESCALATION_ALWAYS_ROLE,
  HttpYiji2Transport,
  MockYiji2Transport,
  YIJI2_CASE_CONFLICT_MESSAGES,
  YIJI2_CASE_CONFLICT_REASONS,
  Yiji2CompensationCases,
  Yiji2Connector,
  Yiji2RefusedError,
  caseFieldsFromDecided,
  caseFieldsFromEscalated,
  caseFieldsFromWire,
  caseTimeLeft,
  compensationCasesOf,
  compensationEscalationRolesValue,
  compensationEventFromYiji2,
  escalationRolesFor,
  formatCaseMoney,
  formatPercentBps,
  mergeCaseStatus,
  parseCaseAmount,
  parseCompensationEscalationRoles,
  ticketCompensationForCase,
  yiji2CaseConflictMessage,
  yiji2OverrideProblem,
  effectivePrivileges,
  OWNER_PRIVILEGES,
  caseFieldsFromGrant,
  isYiji2CompensationGrant,
  stableJson,
  yiji2RequestKey,
} from '../src/index.js';

/**
 * YIJI V2 AUTOMATIC COMPENSATION (owner, 18 Nov 2026; contract
 * auto-compensation-contract.md 2026-11-17): the shared pieces - the events
 * mapper, the CRM row, the override limits, the 409 reasons, the escalation
 * setting, the connector's case calls and the mock's state machine. ZERO
 * NETWORK: the HTTP transport runs on a fake fetch.
 */

const NOW = Date.parse('2026-11-18T10:00:00Z');
const v2 = (t: MockYiji2Transport) =>
  new Yiji2Connector(
    { crmId: 'v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
    { platform: 'yiji2', mock: true },
    { transport: t },
  );

const env = (type: string, data: Record<string, unknown>) => ({
  id: 'evt-1',
  type,
  occurred_at: '2026-11-18T10:00:00Z',
  environment: 'staging',
  data,
});

describe('events -> the workers job', () => {
  it('maps compensation.proposed, .decided and .escalated; anything else is not ours', () => {
    const p = compensationEventFromYiji2(
      env('compensation.proposed', {
        case_id: 900001,
        status: 'evidence_hold',
        row_key: 'HAIR-O1',
        order_number: 2611000000001,
        expires_at: '2026-11-21T10:00:00Z',
        has_photos: false,
      }),
      'yiji2:2',
    );
    expect(p).toMatchObject({
      type: 'compensation.proposed',
      eventId: 'evt-1',
      vendorKey: 'yiji2:2',
    });
    expect(
      compensationEventFromYiji2(
        env('compensation.decided', { case_id: '9', decision: 'expired', order_number: '1' }),
        'yiji2:2',
      )?.type,
    ).toBe('compensation.decided');
    expect(
      compensationEventFromYiji2(
        env('compensation.escalated', {
          case_id: 9,
          escalate_to: 'Operations Manager',
          order_number: 1,
        }),
        'yiji2:2',
      )?.type,
    ).toBe('compensation.escalated');
    expect(compensationEventFromYiji2(env('order.late', {}), 'yiji2:2')).toBeNull();
  });

  it('a malformed one is null and reported, never defaulted', () => {
    const told: string[] = [];
    const malformed = (r: string) => told.push(r);
    expect(
      compensationEventFromYiji2(env('compensation.proposed', { status: 'proposed' }), 'yiji2:2', {
        malformed,
      }),
    ).toBeNull();
    expect(
      compensationEventFromYiji2(
        env('compensation.decided', { case_id: 1, decision: 'maybe', order_number: 1 }),
        'yiji2:2',
        { malformed },
      ),
    ).toBeNull();
    expect(told).toHaveLength(2);
    expect(told[0]).toContain('compensation.proposed');
  });
});

describe('the CRM row', () => {
  it('reads every section-2 field of a case (API or event shape)', () => {
    const f = caseFieldsFromWire({
      id: 900001,
      status: 'proposed',
      source: 'agent',
      trigger_mode: 'AGENT',
      policy_version: 3,
      row_key: 'HAIR-O2',
      rule_code: 'HAIR',
      counter_group: 'HAIR',
      occurrence: 2,
      action_type: 'FIXED',
      comp_method: 'Monetary',
      amount: { amount_minor: 2500, currency: 'SAR' },
      calculation: { formula: 'fixed', cap: 9200 },
      metric_minutes: 42,
      stacked: { row_key: 'PRP-DEL', amount_minor: 1000 },
      escalate_to: 'Operations Manager',
      escalated_at: '2026-11-18T10:00:00Z',
      verification: { status: 'open', note: 'n' },
      expires_at: '2026-11-21T10:00:00Z',
      has_photos: true,
      affected_items: [{ order_item_id: 1, quantity: 1 }],
      text: 'hair in the burger',
      logged_by_agent: 'agent-1',
      order_number: 2611000000001,
      customer_id: 2000000001,
      country: 'SA',
      brand_id: 91,
      restaurant_id: 9101,
      order_total: { amount_minor: 9200, currency: 'SAR' },
    });
    expect(f).toMatchObject({
      case_id: '900001',
      occurrence: 2,
      amount_minor: 2500,
      currency: 'SAR',
      calculation: { formula: 'fixed', cap: '9200' },
      verification: 'open',
      verification_note: 'n',
      expires_at: '2026-11-21T10:00:00.000Z',
      complaint_text: 'hair in the burger',
      order_number: '2611000000001',
      order_total_minor: 9200,
      order_currency: 'SAR',
    });
    /* the event's verification is a bare word */
    expect(caseFieldsFromWire({ case_id: 1, verification: 'confirmed' }).verification).toBe(
      'confirmed',
    );
    /* an absent field never blanks a stored one */
    expect('amount_minor' in caseFieldsFromWire({ case_id: 1 })).toBe(false);
  });

  it('reads a decision and an escalation', () => {
    expect(
      caseFieldsFromDecided({
        case_id: 7,
        decision: 'approved',
        agent_id: 'u-1',
        calculated: { amount_minor: 2000, currency: 'SAR' },
        issued: { amount_minor: 1500, currency: 'SAR' },
        overridden: true,
        wallet_entry_id: 950001,
        at: '2026-11-18T11:00:00Z',
      }),
    ).toMatchObject({
      status: 'approved',
      decided_by: 'u-1',
      calculated_minor: 2000,
      issued_minor: 1500,
      overridden: true,
      wallet_entry_id: '950001',
    });
    expect(
      caseFieldsFromDecided({ case_id: 7, decision: 'expired', by: { kind: 'system' } }),
    ).toMatchObject({ status: 'expired', decided_by: 'system' });
    expect(
      caseFieldsFromEscalated({
        case_id: 7,
        escalate_to: 'Relevant management',
        condition: 'order_total > 200',
        condition_known: false,
        at: '2026-11-18T10:00:00Z',
      }),
    ).toMatchObject({
      escalate_to: 'Relevant management',
      escalation_condition: 'order_total > 200',
      escalation_condition_known: false,
    });
  });

  it('a decided case never goes back to open; the ticket follows the decision', () => {
    expect(mergeCaseStatus('approved', 'proposed')).toBe('approved');
    expect(mergeCaseStatus('proposed', 'approved')).toBe('approved');
    expect(mergeCaseStatus('evidence_hold', 'proposed')).toBe('proposed');
    expect(mergeCaseStatus(null, 'proposed')).toBe('proposed');
    expect(ticketCompensationForCase('approved')).toBe('Compensated');
    for (const s of ['rejected', 'expired', 'failed'])
      expect(ticketCompensationForCase(s)).toBe('Not Compensated');
    expect(ticketCompensationForCase('proposed')).toBeNull();
  });
  it('a released case never goes back on hold (regression: same-time redelivery of the held event)', () => {
    expect(mergeCaseStatus('proposed', 'evidence_hold')).toBe('proposed');
    expect(mergeCaseStatus('needs_bhd_value', 'evidence_hold')).toBe('needs_bhd_value');
    expect(mergeCaseStatus('evidence_hold', 'evidence_hold')).toBe('evidence_hold');
    expect(mergeCaseStatus(null, 'evidence_hold')).toBe('evidence_hold');
    expect(mergeCaseStatus('approved', 'evidence_hold')).toBe('approved');
  });
});

describe('the amount override (contract section 3)', () => {
  const amountCase = {
    amount_minor: 2000,
    currency: 'SAR',
    percent_bps: null,
    action_type: 'FIXED',
    order_total_minor: 9200,
    order_currency: 'SAR',
  };
  it('wallet and amount-coupon cases only, above 0, whole minor units, not above the order total', () => {
    expect(yiji2OverrideProblem(1500, amountCase)).toBeNull();
    expect(yiji2OverrideProblem(9200, amountCase)).toBeNull();
    expect(yiji2OverrideProblem(9201, amountCase)).toBe('above_order_total');
    expect(yiji2OverrideProblem(0, amountCase)).toBe('not_above_zero');
    expect(yiji2OverrideProblem(1.5, amountCase)).toBe('not_whole_minor_units');
    expect(
      yiji2OverrideProblem(100, { ...amountCase, percent_bps: 1500, amount_minor: null }),
    ).toBe('not_amount_case');
    expect(yiji2OverrideProblem(100, { ...amountCase, action_type: 'APOLOGY_ONLY' })).toBe(
      'not_amount_case',
    );
    expect(yiji2OverrideProblem(100, { ...amountCase, order_total_minor: null })).toBe(
      'order_total_unknown',
    );
  });
  it('turns typed amounts into minor units exactly (SAR 2, BHD 3) and formats them back', () => {
    expect(parseCaseAmount('25', 'SAR')).toBe(2500);
    expect(parseCaseAmount('25.5', 'SAR')).toBe(2550);
    expect(parseCaseAmount('0.105', 'BHD')).toBe(105);
    expect(parseCaseAmount('1.234', 'SAR')).toBeNull();
    expect(parseCaseAmount('abc', 'SAR')).toBeNull();
    expect(formatCaseMoney(2550, 'SAR')).toBe('SAR 25.50');
    expect(formatCaseMoney(105, 'BHD')).toBe('BHD 0.105');
    expect(formatCaseMoney(null, 'SAR')).toBe('—');
    expect(formatPercentBps(1500)).toBe('15%');
    expect(formatPercentBps(1250)).toBe('12.50%');
  });
  it('counts down to expires_at', () => {
    expect(caseTimeLeft('2026-11-18T12:30:00Z', NOW)).toEqual({
      expired: false,
      hours: 2,
      minutes: 30,
    });
    expect(caseTimeLeft('2026-11-18T09:00:00Z', NOW)?.expired).toBe(true);
    expect(caseTimeLeft(null, NOW)).toBeNull();
  });
});

describe('409 reasons -> clear messages', () => {
  it('has a message for every reason of the contract, and a general one otherwise', () => {
    for (const r of ['closed', 'expired', 'evidence_hold', 'needs_bhd_value', 'failed', 'not_held'])
      expect(YIJI2_CASE_CONFLICT_REASONS).toContain(r);
    for (const r of YIJI2_CASE_CONFLICT_REASONS)
      expect(yiji2CaseConflictMessage(r)).toBe(YIJI2_CASE_CONFLICT_MESSAGES[r]);
    expect(yiji2CaseConflictMessage('expired')).toMatch(/72 hours/);
    expect(yiji2CaseConflictMessage('needs_bhd_value')).toMatch(/only be rejected/);
    expect(yiji2CaseConflictMessage('weird')).toContain('weird');
    expect(yiji2CaseConflictMessage(null)).toMatch(/refused/);
  });
});

describe('escalation recipients setting (owner rule, 18 Nov 2026)', () => {
  it('defaults: Operations Manager -> WeCare Supervisor, Relevant management -> WeCare Admin', () => {
    const m = parseCompensationEscalationRoles(null);
    expect(m['Operations Manager']).toEqual(['WeCare Supervisor']);
    expect(m['Relevant management']).toEqual(['WeCare Admin']);
    expect(Object.keys(m).sort()).toEqual([...COMPENSATION_ESCALATION_TARGETS].sort());
  });
  it('the Administrator ALWAYS receives every escalation, whatever the mapping', () => {
    expect(COMPENSATION_ESCALATION_ALWAYS_ROLE).toBe('Administrator');
    const d = parseCompensationEscalationRoles(null);
    expect(escalationRolesFor(d, 'Operations Manager')).toEqual([
      'WeCare Supervisor',
      'Administrator',
    ]);
    expect(escalationRolesFor(d, 'Relevant management')).toEqual(['WeCare Admin', 'Administrator']);
    /* An Administrator who maps a target to nothing still hears of it. */
    const empty = parseCompensationEscalationRoles({ 'Operations Manager': [] });
    expect(escalationRolesFor(empty, 'Operations Manager')).toEqual(['Administrator']);
    /* Never twice. */
    const withAdmin = parseCompensationEscalationRoles({
      'Operations Manager': ['Administrator', 'WeCare Supervisor'],
    });
    expect(escalationRolesFor(withAdmin, 'Operations Manager')).toEqual([
      'Administrator',
      'WeCare Supervisor',
    ]);
  });
  it('reads the stored JSON, keeps defaults for an unnamed target, survives garbage', () => {
    const m = parseCompensationEscalationRoles(
      compensationEscalationRolesValue({ 'Operations Manager': ['Operations', ' Operations '] }),
    );
    expect(m['Operations Manager']).toEqual(['Operations']);
    expect(m['Relevant management']).toEqual(['WeCare Admin']);
    expect(parseCompensationEscalationRoles('{not json')['Operations Manager']).toEqual([
      'WeCare Supervisor',
    ]);
  });
  it('matches escalate_to loosely; an unknown target reaches both WeCare managers and the Administrator', () => {
    const m = parseCompensationEscalationRoles({ 'Relevant management': ['CEO'] });
    expect(escalationRolesFor(m, 'relevant  MANAGEMENT')).toEqual(['CEO', 'Administrator']);
    expect(DEFAULT_COMPENSATION_ESCALATION_ROLES).toEqual(['WeCare Supervisor', 'WeCare Admin']);
    expect(escalationRolesFor(m, 'Board')).toEqual([
      'WeCare Supervisor',
      'WeCare Admin',
      'Administrator',
    ]);
  });
});

describe('the new privilege', () => {
  it('approve_compensation_cases is off for every role by default', () => {
    expect(OWNER_PRIVILEGES).toContain('approve_compensation_cases');
    for (const role of ['WeCare Admin', 'WeCare Supervisor', 'WeCare Agent', 'CEO', 'Operations'])
      expect(effectivePrivileges({ approve_coupons: true }, role).approve_compensation_cases).toBe(
        false,
      );
    expect(
      effectivePrivileges({ approve_compensation_cases: true }, 'WeCare Agent')
        .approve_compensation_cases,
    ).toBe(true);
  });
});

describe('the connector: /compensation-cases (mock, zero network)', () => {
  it('only a v2 connector has the case calls', () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    expect(compensationCasesOf(v2(t))).toBeInstanceOf(Yiji2CompensationCases);
    expect(compensationCasesOf({ platform: 'yiji' })).toBeNull();
    expect(compensationCasesOf({ platform: 'mock' })).toBeNull();
    expect(compensationCasesOf(null)).toBeNull();
    expect(
      new Yiji2Connector(
        { crmId: 'v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
        { platform: 'yiji2' },
      ).compensationCases,
    ).toBeNull();
  });

  it('logs a complaint with the Idempotency-Key, and the mock emits compensation.proposed', async () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    const api = compensationCasesOf(v2(t))!;
    const c = await api.logComplaint(
      {
        order_number: '2611000000001',
        category: 'CUT',
        agent_id: 'agent-1',
        has_photos: false,
        text: 'cold',
      },
      'key-log-1',
    );
    expect(c.status).toBe('proposed');
    expect(c.amount).toEqual({ amount_minor: 2000, currency: 'SAR' });
    expect(t.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/compensation-cases',
      idempotencyKey: 'key-log-1',
    });
    expect(t.events.at(-1)).toMatchObject({ type: 'compensation.proposed' });
    /* the same key answers the same case and sends nothing new */
    const again = await api.logComplaint(
      { order_number: '2611000000001', category: 'CUT', agent_id: 'agent-1' },
      'key-log-1',
    );
    expect(again.id).toBe(c.id);
  });

  it('refuses locally what V2 would refuse (unknown category) - nothing is sent', async () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    const api = compensationCasesOf(v2(t))!;
    const err = await api
      .logComplaint(
        { order_number: '2611000000001', category: 'DLY' as never, agent_id: 'a' },
        'k-bad-cat',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Yiji2RefusedError);
    expect((err as Yiji2RefusedError).field).toBe('category');
    expect(t.calls).toHaveLength(0);
    await expect(
      api.logComplaint({ order_number: '2611000000001', category: 'CUT', agent_id: 'a' }, ''),
    ).rejects.toThrow(/Idempotency-Key/);
    await expect(api.get('../x')).rejects.toBeInstanceOf(Yiji2RefusedError);
  });

  it('approves with an override; a repeat answers the approved case', async () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    const api = compensationCasesOf(v2(t))!;
    const id = t.seedCase({});
    const out = await api.approve(
      id,
      { agent_id: 'agent-1', reason: 'ok', amount: { amount_minor: 1500, currency: 'SAR' } },
      'k-approve',
    );
    expect(out).toMatchObject({
      status: 'approved',
      overridden: true,
      issued: { amount_minor: 1500, currency: 'SAR' },
    });
    expect(out.wallet_entry_id).toBeTruthy();
    expect(t.events.at(-1)).toMatchObject({
      type: 'compensation.decided',
      data: { decision: 'approved', agent_id: 'agent-1', overridden: true },
    });
    const repeat = await api.approve(id, { agent_id: 'agent-1', reason: 'ok' }, 'k-approve-2');
    expect(repeat.status).toBe('approved');
  });

  it('every 409 carries its reason', async () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    const api = compensationCasesOf(v2(t))!;
    const reasonOf = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: unknown) => {
          expect(e).toBeInstanceOf(Yiji2RefusedError);
          expect((e as Yiji2RefusedError).status).toBe(409);
          return (e as Yiji2RefusedError).reason;
        },
      );
    const agent = { agent_id: 'a', reason: 'r' };
    expect(await reasonOf(api.approve(t.seedCase({ status: 'rejected' }), agent, 'k1'))).toBe(
      'closed',
    );
    const old = t.seedCase({});
    t.expireCase(old);
    expect(await reasonOf(api.approve(old, agent, 'k2'))).toBe('expired');
    expect(await reasonOf(api.approve(t.seedCase({ status: 'evidence_hold' }), agent, 'k3'))).toBe(
      'evidence_hold',
    );
    expect(
      await reasonOf(
        api.approve(t.seedCase({ status: 'needs_bhd_value', country: 'BH' }), agent, 'k4'),
      ),
    ).toBe('needs_bhd_value');
    const failing = t.seedCase({});
    t.failOnApprove.add(failing);
    expect(await reasonOf(api.approve(failing, agent, 'k5'))).toBe('failed');
    expect(await reasonOf(api.evidence(t.seedCase({}), { agent_id: 'a' }, 'k6'))).toBe('not_held');
    expect(
      await reasonOf(
        api.verification(t.seedCase({}), { agent_id: 'a', result: 'confirmed' }, 'k7'),
      ),
    ).toBe('no_verification');
  });

  it('rejects, confirms photos and closes a camera check', async () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    const api = compensationCasesOf(v2(t))!;
    const r = await api.reject(t.seedCase({}), { agent_id: 'a', reason: 'no' }, 'kr');
    expect(r.status).toBe('rejected');
    const held = t.seedCase({ status: 'evidence_hold', rule_code: 'HAIR', has_photos: true });
    const released = await api.evidence(held, { agent_id: 'a' }, 'ke');
    expect(released.status).toBe('proposed');
    const cctv = t.seedCase({ rule_code: 'MIS', verification: { status: 'open' } });
    const closed = await api.verification(
      cctv,
      { agent_id: 'a', result: 'not_confirmed', note: 'nothing on camera' },
      'kv',
    );
    expect(closed.verification).toMatchObject({ status: 'not_confirmed', by: 'a' });
    await expect(
      api.reject(
        t.seedCase({}),
        { agent_id: 'a', reason: 'x', amount: { amount_minor: 1, currency: 'SAR' } } as never,
        'kx',
      ),
    ).rejects.toBeInstanceOf(Yiji2RefusedError);
  });
});

describe('the HTTP transport reads data.reason of a 409 (fake fetch)', () => {
  it('Yiji2RefusedError.reason is set from error.data.reason', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth/token'))
        return new Response(JSON.stringify({ access_token: 't', expires_in: 900 }), {
          status: 200,
        });
      return new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_TRANSITION',
            message_key: 'case.transition',
            trace_id: 'tr-1',
            data: { reason: 'evidence_hold' },
          },
        }),
        { status: 409 },
      );
    }) as unknown as typeof fetch;
    const api = new Yiji2CompensationCases(
      new HttpYiji2Transport({
        apiBaseUrl: 'https://v2.invalid',
        clientId: 'c',
        clientSecret: 's',
        fetchImpl,
        now: () => NOW,
      }),
    );
    const err = (await api
      .approve('900001', { agent_id: 'a', reason: 'r' }, 'k-http')
      .catch((e: unknown) => e)) as Yiji2RefusedError;
    expect(err).toBeInstanceOf(Yiji2RefusedError);
    expect(err).toMatchObject({ status: 409, code: 'INVALID_TRANSITION', reason: 'evidence_hold' });
    expect(err.traceId).toBe('tr-1');
  });
});

/* ── Review follow-ups (18 Nov 2026) ───────────────────────────────────── */

describe('yiji2RequestKey: one key per distinct request', () => {
  const body = { agent_id: 'u-1', reason: 'late', amount: { amount_minor: 1500, currency: 'SAR' } };
  const k = (b: unknown, base = 'nonce-0001') => yiji2RequestKey(base, { caseId: '9', body: b });

  it('the same request gives the same key, whatever the key order', () => {
    expect(k(body)).toBe(k(body));
    expect(
      k({ amount: { currency: 'SAR', amount_minor: 1500 }, reason: 'late', agent_id: 'u-1' }),
    ).toBe(k(body));
  });

  it('a changed amount, reason, absent field or base is a new key', () => {
    const keys = new Set([
      k(body),
      k({ ...body, amount: { amount_minor: 1200, currency: 'SAR' } }),
      k({ ...body, reason: 'very late' }),
      k({ agent_id: 'u-1', reason: 'late' }),
      k(body, 'nonce-0002'),
    ]);
    expect(keys.size).toBe(5);
  });

  it('fits the gateway and V2 limits', () => {
    expect(k(body)).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(k(body)).toHaveLength(36);
  });

  it('stableJson drops undefined fields and keeps array order', () => {
    expect(stableJson({ b: 1, a: undefined, c: [2, 1] })).toBe('{"b":1,"c":[2,1]}');
  });
});

describe('a compensation coupon.granted (no pending_grant_id)', () => {
  const env = (data: Record<string, unknown>) => ({
    id: 'e-1',
    type: 'coupon.granted',
    occurred_at: '2026-11-17T21:57:45.610701Z',
    data,
  });
  it('becomes a compensation job; a pending one never does', () => {
    const job = compensationEventFromYiji2(
      env({ grant_id: 1, coupon_id: 1, code: 'COMP-6' }),
      'yiji2:2',
    );
    expect(job).toMatchObject({ type: 'coupon.granted', data: { grant_id: 1, code: 'COMP-6' } });
    expect(isYiji2CompensationGrant(env({ grant_id: 1, code: 'X', pending_grant_id: 5 }))).toBe(
      false,
    );
    expect(
      compensationEventFromYiji2(env({ grant_id: 1, code: 'X', pending_grant_id: 5 }), 'yiji2:2'),
    ).toBeNull();
  });
  it('without a grant id or a code: ignored, not malformed', () => {
    const malformed = vi.fn();
    expect(compensationEventFromYiji2(env({ code: 'X' }), 'yiji2:2', { malformed })).toBeNull();
    expect(compensationEventFromYiji2(env({ grant_id: 1 }), 'yiji2:2', { malformed })).toBeNull();
    expect(malformed).not.toHaveBeenCalled();
  });
  it('maps to the coupon columns only', () => {
    expect(
      caseFieldsFromGrant({ grant_id: 1, coupon_id: 2, code: 'COMP-6', status: 'active' }),
    ).toEqual({
      grant_id: '1',
      coupon_id: '2',
      coupon_code: 'COMP-6',
    });
  });
});
