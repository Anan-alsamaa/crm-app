import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  agentSenderLabel,
  clockTime,
  personName,
  sameAgentSender,
  senderIdOf,
} from '../src/features/conversation/message-meta.js';
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';

/**
 * EMA-77 (ops 2026-10-15): every agent bubble said "You", so with several
 * agents in one chat nobody could tell who had said what. Each run now carries
 * the SENDER'S name; the viewer's own read "Name (You)"; the automatic welcome
 * stays "Automatic welcome".
 *
 * EMA-78 (ops 2026-10-18): the time of every message, under day separators.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; name?: string; date?: string }) =>
      (o?.defaultValue ?? k).replace('{{name}}', o?.name ?? '').replace('{{date}}', o?.date ?? ''),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'me', email: 'me@x.sa', first_name: 'Rana', last_name: 'O' },
    can: () => true,
  }),
}));
vi.mock('../src/lib/socket.js', () => ({
  getSocket: vi.fn(() => new Promise(() => {})),
  uploadAttachment: vi.fn(),
}));
vi.mock('../src/lib/sound.js', () => ({ noteSelfSend: vi.fn() }));
vi.mock('../src/features/contacts/api.js', () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
const { Nothing } = vi.hoisted(() => ({ Nothing: () => null }));
vi.mock('../src/features/ai/AiPanel.js', () => ({ AiPanel: Nothing }));
vi.mock('../src/features/conversation/ConversationToolbar.js', () => ({
  ConversationToolbar: Nothing,
}));
vi.mock('../src/features/conversation/ConversationSidebar.js', () => ({
  ConversationSidebar: Nothing,
}));
vi.mock('../src/features/conversation/QuickReplies.js', () => ({ QuickReplies: Nothing }));
vi.mock('../src/features/conversation/EnhanceButton.js', () => ({ EnhanceButton: Nothing }));
vi.mock('../src/features/conversation/PushUnreachableNotice.js', () => ({
  PushUnreachableNotice: Nothing,
}));
vi.mock('../src/features/conversation/AiDraftCard.js', () => ({ AiDraftCard: Nothing }));

const { MESSAGES } = vi.hoisted(() => {
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const MESSAGES = [
    { id: 'c1', sender_type: 'customer', content: 'Where is my order?', date_created: at(1, 9, 0) },
    {
      id: 'w1',
      sender_type: 'agent',
      sender_user: null,
      content: 'Welcome to Yiji',
      date_created: at(1, 9, 1),
    },
    {
      id: 'a1',
      sender_type: 'agent',
      sender_user: 'u-sara',
      content: 'Checking now',
      date_created: at(0, 0, 10),
    },
    {
      id: 'a2',
      sender_type: 'agent',
      sender_user: 'u-omar',
      content: 'I took over',
      date_created: at(0, 0, 12),
    },
    {
      id: 'a3',
      sender_type: 'agent',
      sender_user: 'me',
      content: 'All sorted',
      date_created: at(0, 0, 15),
    },
    {
      id: 'a4',
      sender_type: 'agent',
      sender_user: 'u-gone',
      content: 'Left the company',
      date_created: at(0, 0, 16),
    },
  ].map((m) => ({ is_internal_note: false, ...m }));
  return { MESSAGES };
});

vi.mock('../src/features/inbox/api.js', () => ({
  conversationVendorId: () => '',
  useMessages: () => ({ isLoading: false, data: MESSAGES }),
  useConversation: () => ({
    data: {
      id: 'conv-1',
      status: 'open',
      contact: { id: 'k1', name: 'Huda', phone: '0500000000', email: null },
    },
  }),
  useAgents: () => ({
    data: [
      { id: 'u-sara', email: 'sara@x.sa', first_name: 'Sara', last_name: 'A' },
      { id: 'u-omar', email: 'omar@x.sa', first_name: '', last_name: null },
      { id: 'me', email: 'me@x.sa', first_name: 'Rana', last_name: 'O' },
    ],
  }),
}));

import { ConversationView } from '../src/features/conversation/ConversationView.js';

// jsdom has no scrollTo; the thread pins itself to the bottom with it.
if (!window.HTMLElement.prototype.scrollTo) window.HTMLElement.prototype.scrollTo = () => {};

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConversationView conversationId="conv-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the thread (EMA-77 + EMA-78)', () => {
  it('names the sender of every agent run, never a bare "You"', () => {
    renderView();
    expect(screen.getByText('Sara')).toBeInTheDocument();
    // No first name: the email.
    expect(screen.getByText('omar@x.sa')).toBeInTheDocument();
    // The viewer's own reply.
    expect(screen.getByText('Rana (You)')).toBeInTheDocument();
    // Someone no longer in the agents list.
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  it('labels the automatic welcome as automated, not as a person', () => {
    renderView();
    expect(screen.getByText('Automatic welcome')).toBeInTheDocument();
  });

  it('shows the time of every message and the day separators', () => {
    const { container } = renderView();
    const times = [...container.querySelectorAll('time')].map((el) => el.textContent);
    expect(times).toEqual(['09:00', '09:01', '00:10', '00:12', '00:15', '00:16']);
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
  });
});

describe('message-meta', () => {
  const viewer = { id: 'me', email: 'me@x.sa', first_name: 'Rana' };
  const agents = [
    { id: 'u1', email: 'sara@x.sa', first_name: 'Sara' },
    { id: 'u2', email: 'omar@x.sa', first_name: null },
  ];

  it('resolves names: first name, then email', () => {
    expect(personName({ first_name: ' Sara ', email: 'a@b' })).toBe('Sara');
    expect(personName({ first_name: '', email: 'a@b' })).toBe('a@b');
    expect(personName(null)).toBeNull();
  });

  it('labels self, colleague, unknown and the automatic welcome', () => {
    const msg = (sender_user: string | null | undefined) => ({ sender_type: 'agent', sender_user });
    expect(agentSenderLabel(msg('me'), viewer, agents)).toEqual({ kind: 'self', name: 'Rana' });
    expect(agentSenderLabel(msg('u1'), viewer, agents)).toEqual({ kind: 'agent', name: 'Sara' });
    expect(agentSenderLabel(msg('u2'), viewer, agents)).toEqual({
      kind: 'agent',
      name: 'omar@x.sa',
    });
    expect(agentSenderLabel(msg('zz'), viewer, agents)).toEqual({ kind: 'agent', name: null });
    // An unknown sender (field absent) is a person, never the welcome.
    expect(agentSenderLabel(msg(undefined), viewer, agents)).toEqual({ kind: 'agent', name: null });
    expect(agentSenderLabel(msg(null), viewer, agents)).toEqual({ kind: 'automated' });
  });

  it('splits runs by sender and reads ids in either shape', () => {
    expect(senderIdOf({ sender_user: { id: 'u1' } })).toBe('u1');
    expect(senderIdOf({ sender_user: 'u1' })).toBe('u1');
    expect(sameAgentSender({ sender_user: 'u1' }, { sender_user: { id: 'u1' } })).toBe(true);
    expect(sameAgentSender({ sender_user: 'u1' }, { sender_user: 'u2' })).toBe(false);
  });

  it('formats a 24-hour local clock time', () => {
    expect(clockTime(new Date(2026, 9, 18, 7, 5).toISOString())).toBe('07:05');
    expect(clockTime('nope')).toBe('');
    expect(clockTime(null)).toBe('');
  });

  it('has the new strings in English and Arabic', () => {
    expect(en.conversation.youNamed).toBe('{{name}} (You)');
    expect(ar.conversation.youNamed).toMatch(/\{\{name\}\} \([؀-ۿ]+\)/);
    expect(en.conversation.agentFallback).toBe('Agent');
    expect(ar.conversation.agentFallback).toMatch(/[؀-ۿ]/);
  });
});
