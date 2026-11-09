import { describe, it, expect } from 'vitest';
import {
  beforeAgentMessage,
  deliver,
  onCustomerMessage,
  setMaha,
  type MahaDeps,
  type MahaState,
} from '../src/maha.js';

/** A chat in memory, with every call recorded. */
function harness(opts: {
  config?: Record<string, unknown>;
  state?: Partial<MahaState> | null;
  spend?: number;
  customerTexts?: string[];
  latest?: { id: string; senderType: string; senderUser: string | null } | null;
  failEnqueue?: boolean;
  readConfigThrows?: boolean;
  now?: Date;
}) {
  const state: MahaState | null =
    opts.state === null
      ? null
      : {
          vendorId: 'v1',
          assignedAgent: null,
          active: false,
          replies: 0,
          handoverAt: null,
          agentJoinedAt: null,
          ...opts.state,
        };
  const calls = {
    patches: [] as Array<Record<string, unknown>>,
    messages: [] as Array<{ content: string; source?: string }>,
    toConversation: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    toAgents: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    routing: 0,
    replies: [] as string[],
    watchdogs: [] as string[],
  };
  let latest = opts.latest ?? { id: 'm1', senderType: 'customer', senderUser: null };
  const deps: MahaDeps = {
    directus: {
      getMahaState: async () => (state ? { ...state } : null),
      setMahaState: async (_id, patch) => {
        calls.patches.push(patch);
        if (state) {
          if ('ai_active' in patch) state.active = patch.ai_active === true;
          if ('ai_replies' in patch) state.replies = Number(patch.ai_replies);
          if ('ai_handover_at' in patch)
            state.handoverAt = (patch.ai_handover_at as string) ?? null;
          if ('ai_agent_joined_at' in patch)
            state.agentJoinedAt = (patch.ai_agent_joined_at as string) ?? null;
          if ('assigned_agent' in patch) state.assignedAgent = patch.assigned_agent as string;
        }
      },
      persistMessage: async (input) => {
        calls.messages.push({ content: input.content, source: input.automatedSource });
        const id = `auto${calls.messages.length}`;
        latest = { id, senderType: 'agent', senderUser: null };
        return { id, createdAt: '2026-11-09T10:00:00.000Z' };
      },
      latestVisibleMessage: async () => latest,
      userFirstName: async () => 'Sara',
      recentCustomerTexts: async () => opts.customerTexts ?? ['وين طلبي'],
    },
    readConfig: async () => {
      if (opts.readConfigThrows) throw new Error('redis down');
      return opts.config ?? { chatAi: 'auto' };
    },
    spendSar: async () => opts.spend ?? 0,
    emitToConversation: (_id, event, payload) =>
      calls.toConversation.push({ event, payload: payload as Record<string, unknown> }),
    emitToAgents: (event, payload) =>
      calls.toAgents.push({ event, payload: payload as Record<string, unknown> }),
    enqueueRouting: async () => {
      calls.routing++;
    },
    enqueueMahaReply: async (_c, m) => {
      if (opts.failEnqueue) throw new Error('queue down');
      calls.replies.push(m);
    },
    enqueueWatchdog: async (_c, m) => {
      calls.watchdogs.push(m);
    },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => opts.now ?? new Date('2026-11-09T10:00:00Z'),
  };
  return { deps, calls, state: () => state, setLatest: (l: typeof latest) => (latest = l) };
}

const msg = (over: Partial<Parameters<typeof onCustomerMessage>[1]> = {}) => ({
  conversationId: 'c1',
  messageId: 'm1',
  text: 'وين طلبي؟',
  hasAttachments: false,
  sessionStart: true,
  vendorId: 'v1',
  ...over,
});

describe('a new session', () => {
  it('Maha takes it in auto mode: introduces herself, asks for an answer, arms the watchdog', async () => {
    const h = harness({});
    expect(await onCustomerMessage(h.deps, msg())).toBe(true);
    expect(h.state()?.active).toBe(true);
    expect(h.calls.messages).toEqual([
      { content: 'أهلاً، معك مها من خدمة عملاء يجي 🌷 كيف أقدر أخدمك؟', source: 'maha' },
    ]);
    expect(h.calls.replies).toEqual(['m1']);
    expect(h.calls.watchdogs).toEqual(['m1']);
    expect(h.calls.routing).toBe(0);
    // Silent refresh only - the alert rings at handover.
    expect(h.calls.toAgents.every((e) => e.payload.silent === true)).toBe(true);
  });

  it('introduces herself in English to an English writer', async () => {
    const h = harness({ customerTexts: [] });
    await onCustomerMessage(h.deps, msg({ text: 'where is my order' }));
    expect(h.calls.messages[0]!.content).toMatch(/^Hi, this is Maha/);
  });

  it('a greeting alone gets the introduction and nothing more', async () => {
    const h = harness({});
    expect(await onCustomerMessage(h.deps, msg({ text: 'السلام عليكم' }))).toBe(true);
    expect(h.calls.messages).toHaveLength(1);
    expect(h.calls.replies).toEqual([]);
  });

  it('a greeting with a photo still goes to Maha (who hands it over)', async () => {
    const h = harness({});
    await onCustomerMessage(h.deps, msg({ text: '', hasAttachments: true }));
    expect(h.calls.replies).toEqual(['m1']);
  });

  it.each([
    ['mode off', { config: { chatAi: 'off' } }],
    ['assist only', { config: { chatAi: 'assist' } }],
    ['old shadow flag (assist)', { config: { autoReply: true } }],
    ['outside her hours', { config: { chatAi: 'auto', chatAiFrom: '16:00', chatAiTo: '18:00' } }],
    [
      'monthly budget used up',
      { config: { chatAi: 'auto', chatAiMonthlyCapSar: 250 }, spend: 250 },
    ],
    ['settings unreadable', { readConfigThrows: true }],
  ])('agents take it as before when %s', async (_n, o) => {
    const h = harness(o as never);
    expect(await onCustomerMessage(h.deps, msg())).toBe(false);
    expect(h.state()?.active).toBe(false);
    expect(h.calls.messages).toEqual([]);
    expect(h.calls.replies).toEqual([]);
  });

  it('an environment without the Maha fields behaves exactly as before', async () => {
    const h = harness({ state: null });
    expect(await onCustomerMessage(h.deps, msg())).toBe(false);
    expect(h.calls.patches).toEqual([]);
  });

  it('when the answer cannot be queued, a person takes it at once', async () => {
    const h = harness({ failEnqueue: true });
    expect(await onCustomerMessage(h.deps, msg())).toBe(true);
    expect(h.state()?.active).toBe(false);
    expect(h.calls.routing).toBe(1);
    expect(h.calls.messages.map((m) => m.source)).toEqual(['maha', 'maha_handover']);
  });
});

describe('later messages in the session', () => {
  it('go to Maha while she has the chat', async () => {
    const h = harness({ state: { active: true } });
    expect(await onCustomerMessage(h.deps, msg({ sessionStart: false, messageId: 'm7' }))).toBe(
      true,
    );
    expect(h.calls.replies).toEqual(['m7']);
    expect(h.calls.messages).toEqual([]);
  });
  it('go to people after a handover', async () => {
    const h = harness({ state: { active: false, handoverAt: '2026-11-09T09:00:00Z' } });
    expect(await onCustomerMessage(h.deps, msg({ sessionStart: false }))).toBe(false);
    expect(h.calls.replies).toEqual([]);
  });
});

describe("delivering Maha's decision", () => {
  const job = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'deliver',
      conversationId: 'c1',
      forMessageId: 'm1',
      action: 'reply',
      reply: 'طلبك في الطريق',
      ...over,
    }) as never;

  it('a reply is written as Maha, counted, and refreshes the inbox silently', async () => {
    const h = harness({ state: { active: true, replies: 1 } });
    await deliver(h.deps, job());
    expect(h.calls.messages).toEqual([{ content: 'طلبك في الطريق', source: 'maha' }]);
    expect(h.state()?.replies).toBe(2);
    expect(h.calls.toConversation[0]!.payload).toMatchObject({ automated: true, maha: 'maha' });
    expect(h.calls.routing).toBe(0);
  });

  it('is dropped when the customer has written again (the newer job answers)', async () => {
    const h = harness({
      state: { active: true },
      latest: { id: 'm2', senderType: 'customer', senderUser: null },
    });
    await deliver(h.deps, job());
    expect(h.calls.messages).toEqual([]);
  });

  it('is dropped when an agent turned Maha off meanwhile', async () => {
    const h = harness({ state: { active: false } });
    await deliver(h.deps, job());
    expect(h.calls.messages).toEqual([]);
  });

  it('a handover tells the customer, restarts the clock, rings the alert and routes', async () => {
    const h = harness({ state: { active: true } });
    await deliver(
      h.deps,
      job({ action: 'handover', reply: null, reason: 'late_order', summary: 'Order 123 is late' }),
    );
    expect(h.calls.messages).toEqual([
      { content: 'سأحوّلك الآن لأحد زملائي ليكمل معك، لحظات 🌷', source: 'maha_handover' },
    ]);
    expect(h.calls.patches.at(-1)).toMatchObject({
      ai_active: false,
      ai_handover_reason: 'late_order',
      ai_handover_summary: 'Order 123 is late',
      session_started_at: '2026-11-09T10:00:00.000Z',
      first_responded_at: null,
      first_response_due_at: null,
      first_response_breached_at: null,
    });
    expect(
      h.calls.toAgents.some((e) => e.payload.senderType === 'customer' && !e.payload.silent),
    ).toBe(true);
    expect(h.calls.routing).toBe(1);
  });

  it('an empty reply is a handover, never a blank bubble', async () => {
    const h = harness({ state: { active: true } });
    await deliver(h.deps, job({ reply: '   ' }));
    expect(h.calls.messages.map((m) => m.source)).toEqual(['maha_handover']);
    expect(h.calls.routing).toBe(1);
  });
});

describe('the watchdog', () => {
  const wd = { kind: 'watchdog', conversationId: 'c1', forMessageId: 'm1' } as const;
  it('hands over when the customer is still waiting', async () => {
    const h = harness({ state: { active: true } });
    await deliver(h.deps, wd);
    expect(h.calls.patches.at(-1)).toMatchObject({
      ai_active: false,
      ai_handover_reason: 'ai_timeout',
    });
    expect(h.calls.routing).toBe(1);
  });
  it('does nothing once Maha has answered', async () => {
    const h = harness({
      state: { active: true },
      latest: { id: 'r1', senderType: 'agent', senderUser: null },
    });
    await deliver(h.deps, wd);
    expect(h.calls.routing).toBe(0);
    expect(h.calls.messages).toEqual([]);
  });
});

describe('agents', () => {
  it('cannot send while Maha has the chat', async () => {
    const h = harness({ state: { active: true } });
    expect(await beforeAgentMessage(h.deps, { conversationId: 'c1', agentId: 'a1' })).toEqual({
      blocked: true,
    });
  });

  it('are introduced by first name before their first message after a handover, once', async () => {
    const h = harness({ state: { active: false, handoverAt: '2026-11-09T09:59:00Z' } });
    await beforeAgentMessage(h.deps, { conversationId: 'c1', agentId: 'a1' });
    await beforeAgentMessage(h.deps, { conversationId: 'c1', agentId: 'a1' });
    expect(h.calls.messages).toEqual([
      { content: 'معك Sara من خدمة العملاء', source: 'agent_joined' },
    ]);
  });

  it('are not introduced in a chat Maha never had', async () => {
    const h = harness({ state: { active: false } });
    await beforeAgentMessage(h.deps, { conversationId: 'c1', agentId: 'a1' });
    expect(h.calls.messages).toEqual([]);
  });
});

describe('the per-chat switch', () => {
  it('OFF: the agent takes the chat quietly - no line to the customer, no ladder, no alert', async () => {
    const h = harness({ state: { active: true } });
    expect(await setMaha(h.deps, { conversationId: 'c1', on: false, agentId: 'a1' })).toEqual({
      ok: true,
    });
    expect(h.state()).toMatchObject({ active: false, assignedAgent: 'a1' });
    expect(h.calls.patches.at(-1)).toMatchObject({ ai_handover_reason: 'agent_took_over' });
    expect(h.calls.messages).toEqual([]);
    expect(h.calls.routing).toBe(0);
    expect(h.calls.toAgents.some((e) => e.payload.senderType === 'customer')).toBe(false);
  });

  it('OFF keeps a chat that already has an owner with that owner', async () => {
    const h = harness({ state: { active: true, assignedAgent: 'a9' } });
    await setMaha(h.deps, { conversationId: 'c1', on: false, agentId: 'a1' });
    expect(h.state()?.assignedAgent).toBe('a9');
  });

  it('then the agent is introduced before their first message', async () => {
    const h = harness({ state: { active: true } });
    await setMaha(h.deps, { conversationId: 'c1', on: false, agentId: 'a1' });
    expect(await beforeAgentMessage(h.deps, { conversationId: 'c1', agentId: 'a1' })).toEqual({
      blocked: false,
    });
    expect(h.calls.messages.map((m) => m.source)).toEqual(['agent_joined']);
  });

  it('ON again: Maha continues, answering at once if the customer is waiting', async () => {
    const h = harness({
      state: { active: false, replies: 3 },
      latest: { id: 'm5', senderType: 'customer', senderUser: null },
    });
    expect(await setMaha(h.deps, { conversationId: 'c1', on: true, agentId: 'a1' })).toEqual({
      ok: true,
    });
    expect(h.state()).toMatchObject({ active: true, replies: 0 });
    expect(h.calls.replies).toEqual(['m5']);
  });

  it('ON waits for the customer when the agent spoke last', async () => {
    const h = harness({
      state: { active: false },
      latest: { id: 'x', senderType: 'agent', senderUser: 'a1' },
    });
    await setMaha(h.deps, { conversationId: 'c1', on: true, agentId: 'a1' });
    expect(h.calls.replies).toEqual([]);
  });

  it('ON is refused while the vendor has Maha off', async () => {
    const h = harness({ state: { active: false }, config: { chatAi: 'off' } });
    expect(await setMaha(h.deps, { conversationId: 'c1', on: true, agentId: 'a1' })).toEqual({
      ok: false,
      error: 'maha_off',
    });
  });
});
