import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

/*
 * New-chat alerts: WHERE the agent is decides HOW they are told
 * (owner, 2026-10-14):
 *  - in the CRM on any page but the inbox -> the centre card;
 *  - on the inbox, working in a chat -> a top banner that never blocks typing;
 *  - on the inbox with that very chat open -> nothing.
 */
/* ONE `t` for every render, as i18next gives: a new function per render would
   re-make the socket subscription (and drop its tracked alerts) each time. */
const i18n = vi.hoisted(() => ({
  t: (k: string, o?: { defaultValue?: string; name?: string; n?: number }) =>
    (o?.defaultValue ?? k).replace('{{name}}', o?.name ?? '').replace('{{n}}', String(o?.n ?? '')),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => i18n,
}));

/** Who the chat in the fixture belongs to; null = a general (waiting) chat. */
const owner = vi.hoisted(() => ({ current: 'me' as string | null }));
const handlers = vi.hoisted(() => new Map<string, (e: unknown) => void>());
/** The customer's message as Directus holds it - an edit changes it here too. */
const stored = vi.hoisted(() => ({
  message: { content: 'Where is my order?', deleted_at: null as string | null },
}));
vi.mock('../src/lib/socket.js', () => ({
  getSocket: vi.fn().mockResolvedValue({
    on: (ev: string, fn: (e: unknown) => void) => handlers.set(ev, fn),
    off: vi.fn(),
  }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async (q: { collection: string }) =>
      q.collection === 'conversations'
        ? [
            {
              id: 'c-1',
              status: 'open',
              assigned_agent: owner.current,
              contact: { name: 'Sara Ahmed', phone: '0500000001' },
            },
          ]
        : [{ id: 'm-1', ...stored.message, sender_type: 'customer' }],
    ),
  },
}));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, q: unknown) => ({ collection, q }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));

import { ChatAlerts } from '../src/components/ChatAlerts.js';

function renderAt(path: string) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ChatAlerts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function customerWrites(conversationId = 'c-1') {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0)); // socket subscription
    handlers.get('inbox:activity')?.({ conversationId, senderType: 'customer' });
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => {
  owner.current = 'me';
  stored.message = { content: 'Where is my order?', deleted_at: null };
  handlers.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('ChatAlerts', () => {
  it('on a page other than the inbox: the centre card', async () => {
    renderAt('/tickets');
    await customerWrites();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Sara Ahmed')).toBeInTheDocument();
  });

  it('on the inbox, in another chat: a top banner, never the blocking card', async () => {
    renderAt('/?conv=c-other');
    await customerWrites();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sara Ahmed');
    expect(screen.getByRole('status')).toHaveTextContent('Where is my order?');
  });

  it('on the inbox with that very chat open: nothing', async () => {
    renderAt('/?conv=c-1');
    await customerWrites('c-1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it("an agent's reply clears it", async () => {
    renderAt('/tickets');
    await customerWrites();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => {
      handlers.get('inbox:activity')?.({ conversationId: 'c-1', senderType: 'agent' });
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // WHO is told (owner, 2026-10-14): the assigned agent only; a general chat, everyone.
  it('a chat assigned to ANOTHER agent alerts nobody else', async () => {
    owner.current = 'someone-else';
    renderAt('/tickets');
    await customerWrites();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a general chat (no agent yet) alerts every agent', async () => {
    owner.current = null;
    renderAt('/tickets');
    await customerWrites();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('New chat waiting');
  });
});

/*
 * THE ALERT FOLLOWS THE CUSTOMER'S EDITS (owner, 2026-10-25): an edited
 * message replaces the alert's words - the Windows notification under the
 * same tag, without ringing again - and a withdrawn one closes it.
 */
describe('ChatAlerts — the customer edits or deletes the alerted message', () => {
  class FakeNotification {
    static permission = 'granted';
    static made: FakeNotification[] = [];
    closed = false;
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options: NotificationOptions & { renotify?: boolean },
    ) {
      FakeNotification.made.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    FakeNotification.made = [];
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const edit = async (content: string, messageId = 'm-1') => {
    stored.message = { ...stored.message, content };
    await act(async () => {
      handlers.get('message:edited')?.({
        conversationId: 'c-1',
        messageId,
        content,
        editedAt: '2026-10-25T10:00:00.000Z',
      });
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('replaces the Windows notification under the same tag, without a ring', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // in another program
    renderAt('/tickets');
    await customerWrites();
    expect(FakeNotification.made).toHaveLength(1);
    const first = FakeNotification.made[0]!;
    expect(first.options.body).toBe('Where is my order?');

    await edit('Where is my order #1334028?');

    expect(first.closed).toBe(true);
    expect(FakeNotification.made).toHaveLength(2);
    const second = FakeNotification.made[1]!;
    expect(second.options.body).toBe('Where is my order #1334028?');
    expect(second.options.tag).toBe(first.options.tag);
    expect(second.options.renotify).toBe(false);
    expect(second.options.silent).toBe(true);
  });

  it('updates the centre card text in place', async () => {
    renderAt('/tickets');
    await customerWrites();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Where is my order?');
    await edit('Actually, the order is late');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Actually, the order is late');
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('Where is my order?');
  });

  it('updates the inbox banner text in place', async () => {
    renderAt('/?conv=c-other');
    await customerWrites();
    await edit('Actually, the order is late');
    expect(screen.getByRole('status')).toHaveTextContent('Actually, the order is late');
  });

  it('ignores an edit to a message the alert is not showing', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderAt('/tickets');
    await customerWrites();
    await edit('an older message', 'm-older');
    expect(FakeNotification.made).toHaveLength(1);
    expect(FakeNotification.made[0]!.closed).toBe(false);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Where is my order?');
  });

  it('closes the alert, notification included, when the customer deletes that message', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderAt('/tickets');
    await customerWrites();
    const n = FakeNotification.made[0]!;
    await act(async () => {
      handlers.get('message:deleted')?.({
        conversationId: 'c-1',
        messageId: 'm-1',
        deletedAt: '2026-10-25T10:00:00.000Z',
      });
    });
    expect(n.closed).toBe(true);
    expect(FakeNotification.made).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('follows an edit in a WAITING chat, whose room the agent is not in', async () => {
    // Only the silent inbox activity reaches every agent; the alert re-reads
    // the message it shows.
    owner.current = null;
    renderAt('/tickets');
    await customerWrites();
    stored.message = { ...stored.message, content: 'Edited while waiting' };
    await act(async () => {
      handlers.get('inbox:activity')?.({ conversationId: 'c-1', silent: true });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Edited while waiting');
  });
});
