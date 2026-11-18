import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CompensationCaseRow } from '@yiji/shared-types';

/**
 * YIJI V2 COMPENSATION ON THE TICKET (owner, 18 Nov 2026): the panel shows a
 * V2 case with the contract's section-2 fields and its actions for whoever
 * holds `approve_compensation_cases`; a 409 reads as a clear sentence; a v1
 * ticket shows nothing at all. The gateway client is mocked: zero network.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => {
      let s = String(o?.defaultValue ?? k);
      for (const [name, v] of Object.entries(o ?? {}))
        s = s.replace(new RegExp(`{{${name}}}`, 'g'), String(v));
      return s;
    },
    i18n: { language: 'en' },
  }),
}));

const client = vi.hoisted(() => ({
  forTicket: vi.fn(),
  act: vi.fn(),
  logComplaint: vi.fn(),
  refresh: vi.fn(),
  orderLines: vi.fn(),
}));
vi.mock('../src/lib/compensation-cases-client.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/compensation-cases-client.js')>();
  return { ...real, compensationCases: client, newIdempotencyKey: () => 'key-fixed-0001' };
});

const { V2CompensationPanel, actionsFor } =
  await import('../src/features/tickets/V2CompensationPanel.js');
const { CaseActionError, requestKey } = await import('../src/lib/compensation-cases-client.js');
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';

const caseRow = (over: Partial<CompensationCaseRow> = {}): CompensationCaseRow =>
  ({
    id: 'row-1',
    case_id: '900001',
    ticket: 't-v2',
    vendor: 'vendor-v2',
    status: 'proposed',
    row_key: 'HAIR-O2',
    rule_code: 'HAIR',
    occurrence: 2,
    action_type: 'FIXED',
    comp_method: 'Monetary',
    amount_minor: 2500,
    currency: 'SAR',
    percent_bps: null,
    calculation: { formula: 'fixed 2500', cap_order_total: '9200' },
    metric_minutes: null,
    stacked: null,
    escalate_to: null,
    escalation_condition: null,
    verification: null,
    expires_at: new Date(Date.now() + 5 * 3600_000 + 10 * 60_000).toISOString(),
    has_photos: true,
    affected_items: [{ order_item_id: 1, quantity: 1, unit_price_minor: 3200 }],
    complaint_text: 'hair in the burger',
    order_number: '2611000000001',
    order_total_minor: 9200,
    order_currency: 'SAR',
    decided_by: null,
    decision_reason: null,
    issued_minor: null,
    issued_currency: null,
    overridden: null,
    failure: null,
    agent_actions: null,
    ...over,
  }) as CompensationCaseRow;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  client.forTicket.mockReset();
  client.act.mockReset();
  client.logComplaint.mockReset();
  client.orderLines.mockReset();
  client.orderLines.mockResolvedValue({
    ticketId: 't-v2',
    orderNumber: '2611000000001',
    currency: 'SAR',
    lines: [],
  });
});

describe('V2CompensationPanel', () => {
  it('renders NOTHING for a v1 ticket (v1 unchanged)', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v1',
      v2: false,
      orderNumber: null,
      canAct: true,
      cases: [],
    });
    const { container } = wrap(<V2CompensationPanel ticketId="t-v1" />);
    await waitFor(() => expect(client.forTicket).toHaveBeenCalledWith('t-v1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the gateway cannot be asked', async () => {
    client.forTicket.mockRejectedValue(new Error('down'));
    const { container } = wrap(<V2CompensationPanel ticketId="t-x" />);
    await waitFor(() => expect(client.forTicket).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the section-2 fields of a case', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: false,
      cases: [
        caseRow({
          escalate_to: 'Operations Manager',
          escalation_condition: 'order_total > 200',
          verification: 'open',
          metric_minutes: 38,
        }),
      ],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    expect(await screen.findByText('Case #900001')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(/HAIR · time 2 \(HAIR-O2\)/)).toBeInTheDocument();
    expect(screen.getByText('FIXED · Monetary')).toBeInTheDocument();
    expect(screen.getByText('SAR 25.00')).toBeInTheDocument();
    expect(screen.getByText('formula: fixed 2500')).toBeInTheDocument();
    expect(screen.getByText('38')).toBeInTheDocument();
    expect(
      screen.getByText('Escalated: Operations Manager was notified (order_total > 200).'),
    ).toBeInTheDocument();
    expect(screen.getByText(/5 h \d+ min left/)).toBeInTheDocument();
    expect(screen.getByText('hair in the burger')).toBeInTheDocument();
    expect(screen.getByText(/#1 × 1/)).toBeInTheDocument();
    /* without the privilege: no action, no Log button */
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log V2 complaint' })).toBeNull();
  });

  it('approves with a reason and an amount override in minor units', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [caseRow()],
    });
    client.act.mockResolvedValue({ case: caseRow({ status: 'approved' }) });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const submit = screen.getAllByRole('button', { name: 'Approve' }).at(-1)!;
    expect(submit).toBeDisabled(); // a reason is required
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'late, fair' },
    });
    fireEvent.change(screen.getByLabelText('Different amount (SAR, optional)'), {
      target: { value: '15.5' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.act).toHaveBeenCalledWith('900001', 'approve', {
        ticketId: 't-v2',
        idempotencyKey: requestKey('key-fixed-0001', '900001', 'approve', {
          ticketId: 't-v2',
          reason: 'late, fair',
          amountMinor: 1550,
        }),
        reason: 'late, fair',
        amountMinor: 1550,
      }),
    );
  });

  it('an amount above the order total cannot be sent', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [caseRow()],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Different amount (SAR, optional)'), {
      target: { value: '100' },
    });
    expect(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!).toBeDisabled();
  });

  it('a 409 reads as the reason in plain words', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [caseRow()],
    });
    client.act.mockRejectedValue(new CaseActionError(409, 'conflict', 'expired', null, null));
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'no' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This case passed its 72 hours. It can no longer be approved.',
    );
  });

  it('logs a V2 complaint from a v2 ticket with an order', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [],
    });
    client.logComplaint.mockResolvedValue({
      case: caseRow(),
      ticketId: 't-v2',
      onThisTicket: true,
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log V2 complaint' }));
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'HAIR' },
    });
    fireEvent.click(screen.getByLabelText('The customer sent photos'));
    fireEvent.change(screen.getByLabelText('What the customer said'), {
      target: { value: 'hair' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Yiji V2' }));
    await waitFor(() =>
      expect(client.logComplaint).toHaveBeenCalledWith({
        ticketId: 't-v2',
        idempotencyKey: requestKey('key-fixed-0001', null, 'log', {
          ticketId: 't-v2',
          category: 'HAIR',
          hasPhotos: true,
          text: 'hair',
        }),
        category: 'HAIR',
        hasPhotos: true,
        text: 'hair',
      }),
    );
  });

  /* Review follow-up 1 (18 Nov): the form stays open after a refusal. */
  it('a retry after a refusal: the same body keeps its key, a changed amount or reason gets a new one', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [caseRow()],
    });
    client.act.mockRejectedValue(new CaseActionError(503, 'v2_unavailable', null, null, null));
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const submit = () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
    const keyOf = (n: number) =>
      (client.act.mock.calls[n]![2] as { idempotencyKey: string }).idempotencyKey;
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'late' } });
    fireEvent.change(screen.getByLabelText('Different amount (SAR, optional)'), {
      target: { value: '15' },
    });
    submit();
    await screen.findByRole('alert');
    submit(); // identical retry
    await waitFor(() => expect(client.act).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Different amount (SAR, optional)'), {
      target: { value: '12' },
    });
    submit(); // changed amount
    await waitFor(() => expect(client.act).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'very late' },
    });
    submit(); // changed reason
    await waitFor(() => expect(client.act).toHaveBeenCalledTimes(4));
    fireEvent.change(screen.getByLabelText('Different amount (SAR, optional)'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'late' } });
    submit(); // back to the first body
    await waitFor(() => expect(client.act).toHaveBeenCalledTimes(5));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(keyOf(3)).not.toBe(keyOf(2));
    expect(keyOf(3)).not.toBe(keyOf(0));
    expect(keyOf(4)).toBe(keyOf(0));
    for (let i = 0; i < 5; i++) expect(keyOf(i)).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it('log complaint: a changed category or text is a new key; the same form resent is not', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [],
    });
    client.logComplaint.mockRejectedValue(
      new CaseActionError(503, 'v2_unavailable', null, null, null),
    );
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log V2 complaint' }));
    const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send to Yiji V2' }));
    const keyOf = (n: number) =>
      (client.logComplaint.mock.calls[n]![0] as { idempotencyKey: string }).idempotencyKey;
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'HAIR' },
    });
    send();
    await screen.findByRole('alert');
    send();
    await waitFor(() => expect(client.logComplaint).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'CUT' },
    });
    send();
    await waitFor(() => expect(client.logComplaint).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByLabelText('What the customer said'), { target: { value: 'x' } });
    send();
    await waitFor(() => expect(client.logComplaint).toHaveBeenCalledTimes(4));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(new Set([keyOf(0), keyOf(2), keyOf(3)]).size).toBe(3);
  });

  /* Review follow-up 2 (18 Nov): the case is on another ticket. */
  it.each([
    [
      't-other-7',
      'This order already has a case of that category on ticket t-other-7. Act on it from that ticket.',
    ],
    [
      null,
      'This order already has a case of that category on another ticket, which you cannot open. Ask a supervisor.',
    ],
  ])(
    'log complaint answered case_on_other_ticket (ticket %s): a clear message, no case shown',
    async (other, text) => {
      client.forTicket.mockResolvedValue({
        ticketId: 't-v2',
        v2: true,
        orderNumber: '2611000000001',
        canAct: true,
        cases: [],
      });
      client.logComplaint.mockRejectedValue(
        new CaseActionError(409, 'case_on_other_ticket', null, 'x', null, other),
      );
      wrap(<V2CompensationPanel ticketId="t-v2" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Log V2 complaint' }));
      fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
        target: { value: 'CUT' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send to Yiji V2' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.queryByTestId('v2-case')).toBeNull();
    },
  );

  it('the other-ticket messages exist in English and Arabic', () => {
    const e = (en as { v2Case: { error: Record<string, string> } }).v2Case.error;
    const a = (ar as { v2Case: { error: Record<string, string> } }).v2Case.error;
    expect(e.otherTicket).toContain('{{ticket}}');
    expect(a.otherTicket).toContain('{{ticket}}');
    expect(a.otherTicket).toMatch(/[\u0600-\u06FF]/);
    expect(a.otherTicketHidden).toMatch(/[\u0600-\u06FF]/);
    expect(e.otherTicketHidden).toBeTruthy();
  });

  it('no Log button without an order', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: null,
      canAct: true,
      cases: [],
    });
    const { container } = wrap(<V2CompensationPanel ticketId="t-v2" />);
    await waitFor(() => expect(client.forTicket).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('agents log, supervisors approve, four eyes (owner, 18 Nov 2026)', () => {
  it('a WeCare Agent (canLog, not canAct) sees "Log V2 complaint" but no Approve / Reject', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: false,
      canLog: true,
      ownCases: [],
      cases: [caseRow()],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    expect(await screen.findByRole('button', { name: 'Log V2 complaint' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('a supervisor without log (canAct, canLog false) sees the decisions but no Log button', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      canLog: false,
      ownCases: [],
      cases: [caseRow()],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log V2 complaint' })).toBeNull();
  });

  it('own case: Approve and Reject are not offered, with a note; photos received still is', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      canLog: true,
      ownCases: ['900001', '900002'],
      cases: [caseRow(), caseRow({ id: 'row-2', case_id: '900002', status: 'evidence_hold' })],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    expect(await screen.findAllByTestId('v2-case-own')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Photos received' })).toBeInTheDocument();
  });

  it('a 403 own_case reads in plain words and re-asks the gateway (no stale buttons)', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      canLog: true,
      ownCases: [],
      cases: [caseRow()],
    });
    client.act.mockRejectedValue(new CaseActionError(403, 'own_case', null, null, null));
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'ok' } });
    const calls = client.forTicket.mock.calls.length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You logged this case, so another person must approve or reject it',
    );
    await waitFor(() => expect(client.forTicket.mock.calls.length).toBeGreaterThan(calls));
  });

  it('a 403 for a revoked privilege re-asks the gateway too', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      canLog: true,
      ownCases: [],
      cases: [caseRow()],
    });
    client.act.mockRejectedValue(
      new CaseActionError(403, 'approve_compensation_cases_required', null, null, null),
    );
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'no' } });
    const calls = client.forTicket.mock.calls.length;
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: false,
      canLog: true,
      ownCases: [],
      cases: [caseRow()],
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have the permission');
    await waitFor(() => expect(client.forTicket.mock.calls.length).toBeGreaterThan(calls));
  });

  it('an older gateway without canLog: logging follows canAct as before', async () => {
    client.forTicket.mockResolvedValue({
      ticketId: 't-v2',
      v2: true,
      orderNumber: '2611000000001',
      canAct: true,
      cases: [],
    });
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    expect(await screen.findByRole('button', { name: 'Log V2 complaint' })).toBeInTheDocument();
  });

  it('the own-case and log messages exist in English and Arabic', () => {
    const e = (en as { v2Case: { error: Record<string, string>; ownCase: string } }).v2Case;
    const a = (ar as { v2Case: { error: Record<string, string>; ownCase: string } }).v2Case;
    for (const k of ['ownCase', 'forbiddenLog']) {
      expect(e.error[k], k).toBeTruthy();
      expect(a.error[k], k).toMatch(/[\u0600-\u06FF]/);
    }
    expect(a.ownCase).toMatch(/[\u0600-\u06FF]/);
    expect(e.ownCase).toBeTruthy();
  });
});

describe('actionsFor (which buttons a status offers)', () => {
  it('follows the contract', () => {
    expect(actionsFor({ status: 'proposed', verification: null })).toEqual(['approve', 'reject']);
    expect(actionsFor({ status: 'evidence_hold', verification: null })).toEqual([
      'evidence',
      'reject',
    ]);
    expect(actionsFor({ status: 'needs_bhd_value', verification: null })).toEqual(['reject']);
    expect(actionsFor({ status: 'proposed', verification: 'open' })).toEqual([
      'approve',
      'reject',
      'verification',
    ]);
    expect(actionsFor({ status: 'approved', verification: null })).toEqual([]);
  });
});
