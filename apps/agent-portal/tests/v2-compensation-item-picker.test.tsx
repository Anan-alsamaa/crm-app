import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';

/**
 * "LOG V2 COMPLAINT": THE AFFECTED-ITEMS PICKER (2026-11-18; partner-v1.yaml
 * `OrderItem.order_item_id`). The lines come from the gateway's read of the
 * ticket's V2 order; the agent ticks lines and sets 1..line quantity; a
 * category paid on the items cannot be sent without one. English and Arabic
 * are read from the real translation files. The gateway client is mocked:
 * zero network.
 */

const i18n = vi.hoisted(() => ({ lang: 'en' }));
const dicts: Record<string, unknown> = { en, ar };
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => {
      let node: unknown = dicts[i18n.lang];
      for (const part of k.split('.'))
        node =
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
      let s = typeof node === 'string' ? node : String(o?.defaultValue ?? k);
      for (const [name, v] of Object.entries(o ?? {}))
        s = s.replace(new RegExp(`{{${name}}}`, 'g'), String(v));
      return s;
    },
    i18n: { language: i18n.lang },
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

const { V2CompensationPanel } = await import('../src/features/tickets/V2CompensationPanel.js');
const { CaseActionError, requestKey } = await import('../src/lib/compensation-cases-client.js');

/* The first line is V2's own sample item (order-item-id.md section 7). */
const LINES = {
  ticketId: 't-v2',
  orderNumber: '2611000000001',
  currency: 'SAR',
  lines: [
    {
      orderItemId: '7001',
      name: 'Burger',
      nameAr: 'برجر',
      modifiers: ['Cheese'],
      quantity: 2,
      unitPriceMinor: 2500,
      lineTotalMinor: 5000,
    },
    {
      orderItemId: '7002',
      name: 'Fries',
      nameAr: null,
      modifiers: [],
      quantity: 1,
      unitPriceMinor: 1200,
      lineTotalMinor: 1200,
    },
  ],
};

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  i18n.lang = 'en';
  for (const f of Object.values(client)) f.mockReset();
  client.forTicket.mockResolvedValue({
    ticketId: 't-v2',
    v2: true,
    orderNumber: '2611000000001',
    canAct: false,
    canLog: true,
    cases: [],
  });
  client.orderLines.mockResolvedValue(LINES);
  client.logComplaint.mockResolvedValue({ case: {}, ticketId: 't-v2', onThisTicket: true });
});

async function openForm(category?: string) {
  wrap(<V2CompensationPanel ticketId="t-v2" />);
  const log = i18n.lang === 'ar' ? ar.v2Case.log : 'Log V2 complaint';
  fireEvent.click(await screen.findByRole('button', { name: log }));
  await screen.findAllByTestId('v2-item-line');
  if (category)
    fireEvent.change(
      screen.getByLabelText(i18n.lang === 'ar' ? ar.v2Case.category : 'Complaint (policy code)'),
      { target: { value: category } },
    );
}
const send = () => screen.getByRole('button', { name: 'Send to Yiji V2' });

describe('the affected-items picker', () => {
  it('lists the order’s lines from the V2 order read: name, add-ons, quantity, price', async () => {
    await openForm();
    expect(client.orderLines).toHaveBeenCalledWith('t-v2');
    const [burger, fries] = screen.getAllByTestId('v2-item-line');
    expect(within(burger!).getByText('Burger')).toBeInTheDocument();
    expect(within(burger!).getByText('Cheese')).toBeInTheDocument();
    expect(within(burger!).getByText('Quantity 2 · SAR 25.00 each')).toBeInTheDocument();
    expect(within(fries!).getByText('Quantity 1 · SAR 12.00 each')).toBeInTheDocument();
  });

  it('select lines and quantities: sent as affectedItems [{ orderItemId, quantity }]', async () => {
    await openForm('MIS');
    fireEvent.click(screen.getByRole('checkbox', { name: /Burger/ }));
    const qty = screen.getByLabelText('Affected quantity of Burger');
    expect(qty).toHaveValue(2); // the whole line by default
    fireEvent.change(qty, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Fries/ }));
    fireEvent.click(send());
    const affectedItems = [
      { orderItemId: '7001', quantity: 1 },
      { orderItemId: '7002', quantity: 1 },
    ];
    await waitFor(() =>
      expect(client.logComplaint).toHaveBeenCalledWith({
        ticketId: 't-v2',
        category: 'MIS',
        affectedItems,
        hasPhotos: false,
        idempotencyKey: requestKey('key-fixed-0001', null, 'log', {
          ticketId: 't-v2',
          category: 'MIS',
          affectedItems,
          hasPhotos: false,
        }),
      }),
    );
  });

  it('a changed pick is a new idempotency key', async () => {
    client.logComplaint.mockRejectedValue(
      new CaseActionError(503, 'v2_unavailable', null, null, null),
    );
    await openForm('MIS');
    fireEvent.click(screen.getByRole('checkbox', { name: /Burger/ }));
    fireEvent.click(send());
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Affected quantity of Burger'), {
      target: { value: '1' },
    });
    fireEvent.click(send());
    await waitFor(() => expect(client.logComplaint).toHaveBeenCalledTimes(2));
    const keys = client.logComplaint.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('quantity limits: 1..the line’s quantity, whole numbers only', async () => {
    await openForm('MIS');
    fireEvent.click(screen.getByRole('checkbox', { name: /Burger/ }));
    const qty = screen.getByLabelText('Affected quantity of Burger');
    expect(qty).toHaveAttribute('min', '1');
    expect(qty).toHaveAttribute('max', '2');
    for (const v of ['3', '0', '', '1.5']) {
      fireEvent.change(qty, { target: { value: v } });
      expect(send()).toBeDisabled();
      expect(qty).toHaveAttribute('aria-invalid', 'true');
    }
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 2.');
    fireEvent.change(qty, { target: { value: '2' } });
    expect(send()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    /* Unticking removes the line (and its quantity) from the pick. */
    fireEvent.click(screen.getByRole('checkbox', { name: /Burger/ }));
    expect(screen.queryByLabelText('Affected quantity of Burger')).toBeNull();
  });

  it('required for a category paid on items; optional otherwise', async () => {
    await openForm();
    for (const code of ['PRD-1', 'PRD-2', 'ACC-1', 'ACC-2', 'MIS', 'REM']) {
      fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
        target: { value: code },
      });
      expect(screen.getByText('Affected items (required)')).toBeInTheDocument();
      expect(screen.getByTestId('v2-items-required')).toHaveTextContent(
        'Choose at least one item for this category.',
      );
      expect(send()).toBeDisabled();
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Fries/ }));
    expect(screen.queryByTestId('v2-items-required')).toBeNull();
    expect(send()).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Fries/ }));
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'CUT' },
    });
    expect(screen.getByText('Affected items (optional)')).toBeInTheDocument();
    expect(send()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'HAIR' },
    });
    expect(
      screen.getByText(/From the second time, this category is paid on the items/),
    ).toBeInTheDocument();
    fireEvent.click(send());
    await waitFor(() =>
      expect(client.logComplaint.mock.calls[0]![0]).not.toHaveProperty('affectedItems'),
    );
  });

  it('the gateway’s item refusal reads as a sentence', async () => {
    client.logComplaint.mockRejectedValue(
      new CaseActionError(
        400,
        'invalid_affected_items',
        null,
        'x',
        null,
        null,
        'item_not_on_order',
      ),
    );
    await openForm('MIS');
    fireEvent.click(screen.getByRole('checkbox', { name: /Fries/ }));
    fireEvent.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An item is not a line of this ticket’s order. Choose the items again.',
    );
  });

  it('when the order cannot be read: says so; an optional category can still be sent', async () => {
    client.orderLines.mockRejectedValue(
      new CaseActionError(503, 'v2_unavailable', null, null, null),
    );
    wrap(<V2CompensationPanel ticketId="t-v2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log V2 complaint' }));
    expect(
      await screen.findByText(
        'The order’s items could not be read from Yiji V2. Try again shortly.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'MIS' },
    });
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Complaint (policy code)'), {
      target: { value: 'CUT' },
    });
    expect(send()).toBeEnabled();
  });
});

describe('the picker in Arabic', () => {
  it('shows the Arabic names, labels, prices line and messages', async () => {
    i18n.lang = 'ar';
    await openForm('MIS');
    expect(screen.getByText(ar.v2Case.picker.legendRequired)).toBeInTheDocument();
    expect(screen.getByText('برجر')).toBeInTheDocument();
    /* No Arabic name sent: the English name stays. */
    expect(screen.getByText('Fries')).toBeInTheDocument();
    expect(screen.getByText('الكمية 2 · SAR 25.00 للوحدة')).toBeInTheDocument();
    expect(screen.getByTestId('v2-items-required')).toHaveTextContent(ar.v2Case.picker.required);
    fireEvent.click(screen.getByRole('checkbox', { name: /برجر/ }));
    const qty = screen.getByLabelText('الكمية المتأثرة من برجر');
    fireEvent.change(qty, { target: { value: '5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('أدخل عددًا صحيحًا من 1 إلى 2.');
  });

  it('every picker string has Arabic', () => {
    const e = en.v2Case.picker as Record<string, string>;
    const a = ar.v2Case.picker as Record<string, string>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort());
    for (const k of Object.keys(e)) {
      expect(a[k]).toMatch(/[؀-ۿ]/);
      for (const v of e[k]!.match(/{{\w+}}/g) ?? []) expect(a[k]).toContain(v);
      expect(e[k]).not.toContain('—');
    }
  });
});
