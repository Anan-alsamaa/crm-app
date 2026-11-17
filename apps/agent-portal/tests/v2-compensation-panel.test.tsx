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
}));
vi.mock('../src/lib/compensation-cases-client.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/compensation-cases-client.js')>();
  return { ...real, compensationCases: client, newIdempotencyKey: () => 'key-fixed-0001' };
});

const { V2CompensationPanel, actionsFor } =
  await import('../src/features/tickets/V2CompensationPanel.js');
const { CaseActionError } = await import('../src/lib/compensation-cases-client.js');

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
        idempotencyKey: 'key-fixed-0001',
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
        idempotencyKey: 'key-fixed-0001',
        category: 'HAIR',
        hasPhotos: true,
        text: 'hair',
      }),
    );
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
