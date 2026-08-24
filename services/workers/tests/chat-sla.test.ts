import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { runChatReconcile, type SlaDeps } from '../src/processors/sla.js';
import type {
  ConversationRepo,
  ConversationRow,
  SlaPolicyRow,
  TeamRepo,
  TicketRepo,
} from '../src/processors/repos.js';

/*
 * THE CHAT FIRST-RESPONSE CLOCK.
 *
 * This exists because the same promise was previously measured on the wrong
 * object. A ticket carried `first_response_due_at` and nothing in the product
 * ever wrote the matching `first_responded_at` — the reply that answers a
 * customer happens in the CHAT, usually before anyone decides a ticket is
 * warranted. Every such ticket breached and stayed breached.
 *
 * So the tests that matter most here are the two that would have caught that:
 * something must WRITE the response time, and a policy must not be able to
 * govern the wrong object.
 */

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const CHAT_POLICY: SlaPolicyRow = {
  id: 'chat-1',
  name: 'Chat first response',
  governs: 'chat',
  applies_to_priority: ['low', 'medium', 'high', 'urgent'],
  first_response_minutes: 5,
  resolution_minutes: 480,
  warning_threshold_percent: 80,
  business_hours: null,
  active: true,
};

const TICKET_POLICY: SlaPolicyRow = {
  ...CHAT_POLICY,
  id: 'ticket-1',
  name: 'Ticket resolution',
  governs: 'ticket',
};

function chat(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'c1',
    status: 'open',
    priority: 'medium',
    first_response_due_at: null,
    first_responded_at: null,
    first_response_breached_at: null,
    assigned_agent: 'agent-1',
    assigned_team: 'team-1',
    date_created: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function harness(chats: ConversationRow[], policies: SlaPolicyRow[] = [CHAT_POLICY]) {
  const patches: Array<{ id: string; patch: Partial<ConversationRow> }> = [];
  const notifications: Array<{ data: Record<string, unknown>; opts?: { jobId?: string } }> = [];

  const conversations: ConversationRepo = {
    listUnansweredConversations: async () => chats,
    patchConversation: async (id, patch) => {
      patches.push({ id, patch });
      Object.assign(chats.find((c) => c.id === id) ?? {}, patch as Partial<ConversationRow>);
    },
  };
  const tickets = {
    listActiveSlaPolicies: async () => policies,
  } as unknown as TicketRepo;
  const teams: TeamRepo = { listMemberIds: async () => ['mate-1', 'mate-2'] };

  const deps: SlaDeps = {
    tickets,
    conversations,
    teams,
    slaQueue: { add: vi.fn() } as unknown as Queue,
    notificationsQueue: {
      add: vi.fn(async (_name, data, opts) => {
        notifications.push({ data: data as Record<string, unknown>, opts });
      }),
    } as unknown as Queue,
    logger,
  };
  return { deps, patches, notifications, chats };
}

describe('runChatReconcile — setting the clock', () => {
  it('writes a deadline measured from when the customer first wrote', async () => {
    const created = new Date('2026-08-24T10:00:00.000Z').toISOString();
    const { deps, patches } = harness([chat({ date_created: created })]);
    await runChatReconcile(deps);
    // Five minutes, round the clock.
    expect(patches[0]?.patch.first_response_due_at).toBe('2026-08-24T10:05:00.000Z');
  });

  it('never recomputes a deadline a customer is already waiting under', async () => {
    /*
     * Editing a policy changes what FUTURE chats are promised. Recomputing would
     * let an operator widening the target retroactively un-breach every late
     * chat in the inbox, and the report would show a problem that had healed
     * itself overnight.
     */
    const due = new Date(Date.now() + 60_000).toISOString();
    const { deps, patches } = harness(
      [chat({ first_response_due_at: due })],
      [{ ...CHAT_POLICY, first_response_minutes: 999 }],
    );
    await runChatReconcile(deps);
    expect(patches).toHaveLength(0);
  });

  it('leaves a chat alone when no chat policy covers it', async () => {
    // A chat under no policy is visibly under no policy. Inventing a default
    // would put every conversation in the system under a promise nobody wrote.
    const { deps, patches, notifications } = harness(
      [chat({ priority: 'low' })],
      [{ ...CHAT_POLICY, applies_to_priority: ['urgent'] }],
    );
    await runChatReconcile(deps);
    expect(patches).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('will NOT use a ticket policy for a chat, however well its coverage fits', async () => {
    /*
     * The regression that motivated the whole `governs` field. Both policies in
     * this deployment cover all four priorities, so without the object check the
     * chat sweep would attach whichever sorted first — and an eight-hour
     * resolution target would silently become the promise to answer.
     */
    const { deps, patches } = harness([chat()], [TICKET_POLICY]);
    await runChatReconcile(deps);
    expect(patches).toHaveLength(0);
  });
});

describe('runChatReconcile — the breach', () => {
  it('records the breach and pages the assigned agent, once', async () => {
    const overdue = new Date(Date.now() - 60_000).toISOString();
    const { deps, patches, notifications } = harness([chat({ first_response_due_at: overdue })]);
    await runChatReconcile(deps);

    expect(patches[0]?.patch.first_response_breached_at).toBeTruthy();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.data.recipientId).toBe('agent-1');
    expect(notifications[0]?.data.link).toBe('/inbox/c1');
    // Deterministic per (chat, recipient) so a retried sweep cannot double-page.
    expect(notifications[0]?.opts?.jobId).toBe('chatsla-c1-agent-1');
  });

  it('does not page again on the next sweep', async () => {
    /*
     * The ledger is the whole reason the breach timestamp is stored. Without it
     * the sweep re-pages every few minutes for as long as the chat sits
     * unanswered — the alert fatigue that made the old ticket first-response
     * breaches worth nothing.
     */
    const overdue = new Date(Date.now() - 60_000).toISOString();
    const { deps, notifications } = harness([chat({ first_response_due_at: overdue })]);
    await runChatReconcile(deps);
    await runChatReconcile(deps);
    expect(notifications).toHaveLength(1);
  });

  it('tells the TEAM when nobody owns the chat', async () => {
    // An unanswered chat with no owner is the case that matters most: nobody
    // picked it up, which is usually why it went unanswered.
    const overdue = new Date(Date.now() - 60_000).toISOString();
    const { deps, notifications } = harness([
      chat({ first_response_due_at: overdue, assigned_agent: null }),
    ]);
    await runChatReconcile(deps);
    expect(notifications.map((n) => n.data.recipientId).sort()).toEqual(['mate-1', 'mate-2']);
    expect(String(notifications[0]?.data.body)).toMatch(/unassigned/);
  });

  it('does not copy the team when the chat has an owner', async () => {
    // Paging eight people about one agent's late reply is the noise that stops
    // anyone reading these at all.
    const overdue = new Date(Date.now() - 60_000).toISOString();
    const { deps, notifications } = harness([chat({ first_response_due_at: overdue })]);
    await runChatReconcile(deps);
    expect(notifications).toHaveLength(1);
  });

  it('says nothing about a chat that is still inside its target', async () => {
    const due = new Date(Date.now() + 5 * 60_000).toISOString();
    const { deps, notifications } = harness([chat({ first_response_due_at: due })]);
    await runChatReconcile(deps);
    expect(notifications).toHaveLength(0);
  });

  it('judges no chat that was answered between the read and the check', async () => {
    const overdue = new Date(Date.now() - 60_000).toISOString();
    const { deps, notifications, patches } = harness([
      chat({ first_response_due_at: overdue, first_responded_at: new Date().toISOString() }),
    ]);
    await runChatReconcile(deps);
    expect(notifications).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });
});

describe('runChatReconcile — containment', () => {
  it('does nothing at all when the deployment has no conversation repo', async () => {
    // A deployment that has not applied the conversation columns yet must not
    // take the ticket sweep down with it.
    const { deps } = harness([chat()]);
    await expect(runChatReconcile({ ...deps, conversations: undefined })).resolves.toBeUndefined();
  });

  it('survives a read failure without touching the ticket sweep it follows', async () => {
    const { deps, notifications } = harness([chat()]);
    deps.conversations!.listUnansweredConversations = async () => {
      throw new Error('directus down');
    };
    await expect(runChatReconcile(deps)).resolves.toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  it('lets one unusable policy cost only its own chats', async () => {
    /*
     * `computeDueAt` throws on working hours it cannot satisfy. Unguarded, one
     * such policy aborts the sweep for every chat behind it — which is exactly
     * how the ticket SLA went silent for the whole life of the feature.
     */
    const broken: SlaPolicyRow = {
      ...CHAT_POLICY,
      id: 'broken',
      name: 'A Broken',
      applies_to_priority: ['high'],
      business_hours: { timezone: 'Asia/Riyadh', days: {} },
    };
    const { deps, patches } = harness(
      [chat({ id: 'bad', priority: 'high' }), chat({ id: 'good', priority: 'medium' })],
      [broken, { ...CHAT_POLICY, applies_to_priority: ['medium'] }],
    );
    await runChatReconcile(deps);
    // The broken policy's own chat is skipped; the one behind it in the list is
    // still given its deadline — and, being an hour old against a five-minute
    // target, its breach as well.
    expect(patches.some((p) => p.id === 'bad')).toBe(false);
    expect(patches.filter((p) => p.id === 'good')).toHaveLength(2);
  });
});

describe('runChatReconcile — a policy cannot promise backwards', () => {
  it('ignores chats that started before the policy was written', async () => {
    /*
     * The moment a chat policy is created, every conversation already sitting
     * unanswered becomes overdue against it — 123 of them in this database when
     * the feature shipped, none of which anyone could have known about. Judging
     * those would page the whole team at once and open the chat SLA report on a
     * wall of breaches that describe seeding, not service.
     */
    const { deps, patches, notifications } = harness(
      [chat({ date_created: '2026-01-01T00:00:00.000Z' })],
      [{ ...CHAT_POLICY, date_created: '2026-08-24T00:00:00.000Z' }],
    );
    await runChatReconcile(deps);
    expect(patches).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('still governs a chat that started after it', async () => {
    const { deps, patches } = harness(
      [chat({ date_created: '2026-08-25T09:00:00.000Z' })],
      [{ ...CHAT_POLICY, date_created: '2026-08-24T00:00:00.000Z' }],
    );
    await runChatReconcile(deps);
    expect(patches[0]?.patch.first_response_due_at).toBe('2026-08-25T09:05:00.000Z');
  });

  it('governs everything when the policy has no creation date recorded', async () => {
    // Directus always stamps it, but a stub or an older row may not — and going
    // silent would be the worse failure of the two.
    const { deps, patches } = harness([chat({ date_created: '2020-01-01T00:00:00.000Z' })]);
    await runChatReconcile(deps);
    expect(patches.length).toBeGreaterThan(0);
  });
});
