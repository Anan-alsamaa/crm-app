import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BRANCH_MESSAGE_MAX } from '@yiji/shared-types';

/**
 * MESSAGE A BRANCH (owner, 26 Nov 2026): a custom message to a branch's
 * SaraPOS printer, no ticket. The server enforces the rules; these tests pin
 * what the form sends and what it tells the agent before they press Send.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; [v: string]: unknown }) => {
      let s = o?.defaultValue ?? k;
      for (const [name, val] of Object.entries(o ?? {})) s = s.replace(`{{${name}}}`, String(val));
      return s;
    },
    i18n: { language: 'en' },
  }),
}));

const auth = vi.hoisted(() => ({ can: vi.fn((_p: string) => true) }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'me', first_name: 'Nada' }, can: auth.can }),
}));

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ op: 'read', collection, query }),
  createItem: (collection: string, item: unknown) => ({ op: 'create', collection, item }),
}));

type Cmd = { op: string; collection: string; query?: { filter?: unknown }; item?: unknown };
const api = vi.hoisted(() => ({ created: [] as unknown[], createFails: null as unknown }));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd.op === 'create') {
        if (api.createFails) throw api.createFails;
        api.created.push(cmd.item);
        return { id: 'new' };
      }
      if (cmd.collection === 'stores') {
        // The SaraPOS-connected ids, or the full branch list.
        if (cmd.query?.filter) return [{ id: 'lab' }];
        return [
          { id: 'lab', code: 'LCP-095', name: 'One Square RYD', city: 'Riyadh', brand: null },
          { id: 'nopos', code: 'LCP-001', name: 'No Printer Branch', city: 'Riyadh', brand: null },
        ];
      }
      if (cmd.collection === 'quick_replies') {
        return [
          {
            id: 'q1',
            label: 'Call WeCare',
            text: 'Please call WeCare about order {order}.',
            lang: 'en',
            kind: 'branch_message',
          },
          { id: 'q2', label: 'Hello', text: 'Hello customer', lang: 'en', kind: 'chat' },
        ];
      }
      return []; // store_notifications: no recent messages
    }),
  },
}));

import {
  BranchMessageButton,
  BranchMessageDialog,
} from '../src/features/branch-message/BranchMessage.js';

function renderWith(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/* The dialog's focus trap moves focus in just after it opens; typing before
   that lands in whichever field it picks. A person never types that fast. */
async function openDialog() {
  renderWith(<BranchMessageDialog open onClose={() => {}} />);
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
}

async function pickBranch(name: RegExp) {
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name }));
}

const sendButton = () => screen.getByRole('button', { name: 'Send to branch' });
const messageBox = () => screen.getByPlaceholderText('What the branch needs to know or do.');

beforeEach(() => {
  api.created = [];
  api.createFails = null;
  auth.can.mockImplementation(() => true);
});

describe('the top-bar button', () => {
  it('is there for a role with send_branch_messages, and absent without it', () => {
    const { unmount } = renderWith(<BranchMessageButton />);
    expect(screen.getByRole('button', { name: 'Message a branch' })).toBeInTheDocument();
    expect(auth.can).toHaveBeenCalledWith('send_branch_messages');
    unmount();
    auth.can.mockImplementation(() => false);
    renderWith(<BranchMessageButton />);
    expect(screen.queryByRole('button', { name: 'Message a branch' })).toBeNull();
  });
});

describe('the Message a branch form', () => {
  it('offers only branches connected to SaraPOS', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: /One Square RYD/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /No Printer Branch/ })).toBeNull();
  });

  it('sends only once a branch and a message are there, and sends exactly those', async () => {
    await openDialog();
    expect(sendButton()).toBeDisabled();
    await pickBranch(/One Square RYD/);
    expect(sendButton()).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('1350658'), '1350658');
    await userEvent.type(messageBox(), '  Customer is on the way to collect.  ');
    // What will print: the heading with the order, then the text.
    expect(screen.getByText('WeCare message - Order 1350658')).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    await userEvent.click(sendButton());
    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0]).toEqual({
      kind: 'custom',
      store: 'lab',
      description: 'Customer is on the way to collect.',
      order_id: '1350658',
    });
  });

  it('a ready message fills the box, with the order number put in', async () => {
    await openDialog();
    await userEvent.type(screen.getByPlaceholderText('1350658'), '777');
    await userEvent.click(await screen.findByText('Ready messages'));
    await userEvent.click(await screen.findByText('Call WeCare'));
    expect(messageBox()).toHaveValue('Please call WeCare about order 777.');
    // The chat library is not offered here.
    expect(screen.queryByText('Hello')).toBeNull();
  });

  it('counts characters and will not send past the limit', async () => {
    await openDialog();
    await pickBranch(/One Square RYD/);
    await userEvent.click(messageBox());
    await userEvent.paste('x'.repeat(BRANCH_MESSAGE_MAX + 1));
    expect(screen.getByText(`${BRANCH_MESSAGE_MAX + 1}/${BRANCH_MESSAGE_MAX}`)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('warns when the text looks like a customer phone number', async () => {
    await openDialog();
    expect(screen.queryByText(/looks like a phone number/)).toBeNull();
    await userEvent.type(messageBox(), 'Customer 0551234567 is waiting');
    expect(screen.getByText(/looks like a phone number/)).toBeInTheDocument();
  });

  it("shows the server's reason when it refuses", async () => {
    api.createFails = {
      errors: [{ message: 'This branch already received 5 messages in the last hour.' }],
    };
    await openDialog();
    await pickBranch(/One Square RYD/);
    await userEvent.type(messageBox(), 'Please call WeCare.');
    await userEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This branch already received 5 messages in the last hour.',
    );
  });
});
