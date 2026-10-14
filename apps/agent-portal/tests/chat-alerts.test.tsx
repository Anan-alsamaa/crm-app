import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; name?: string; n?: number }) =>
      (o?.defaultValue ?? k)
        .replace('{{name}}', o?.name ?? '')
        .replace('{{n}}', String(o?.n ?? '')),
  }),
}));

/** Who the chat in the fixture belongs to; null = a general (waiting) chat. */
const owner = vi.hoisted(() => ({ current: 'me' as string | null }));
const handlers = vi.hoisted(() => new Map<string, (e: unknown) => void>());
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
        : [{ content: 'Where is my order?', sender_type: 'customer' }],
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
