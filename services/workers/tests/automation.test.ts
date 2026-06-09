import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import {
  evalCondition,
  evalAllConditions,
  processAutomationJob,
  type AutomationDeps,
  type AutomationRuleRow,
} from '../src/processors/automation.js';
import { AUTOMATION_MAX_DEPTH, type AutomationJob } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import type { Logger } from 'pino';

const noopLog: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => noopLog,
} as unknown as Logger;

describe('evalCondition', () => {
  const ctx = {
    entity: { type: 'ticket', id: 't1' },
    context: { priority: 'high', subject: 'Hello world', count: 5, status: 'open' },
  };

  it('eq / neq', () => {
    expect(evalCondition(ctx, { field: 'context.priority', op: 'eq', value: 'high' })).toBe(true);
    expect(evalCondition(ctx, { field: 'context.priority', op: 'neq', value: 'low' })).toBe(true);
    expect(evalCondition(ctx, { field: 'context.priority', op: 'eq', value: 'low' })).toBe(false);
  });

  it('contains / starts_with (case-insensitive)', () => {
    expect(evalCondition(ctx, { field: 'context.subject', op: 'contains', value: 'WORLD' })).toBe(
      true,
    );
    expect(
      evalCondition(ctx, { field: 'context.subject', op: 'starts_with', value: 'HELLO' }),
    ).toBe(true);
    expect(evalCondition(ctx, { field: 'context.subject', op: 'contains', value: 'xyz' })).toBe(
      false,
    );
  });

  it('gt / lt (numeric)', () => {
    expect(evalCondition(ctx, { field: 'context.count', op: 'gt', value: 4 })).toBe(true);
    expect(evalCondition(ctx, { field: 'context.count', op: 'lt', value: 10 })).toBe(true);
    expect(evalCondition(ctx, { field: 'context.count', op: 'gt', value: 100 })).toBe(false);
  });

  it('in (array contains)', () => {
    expect(
      evalCondition(ctx, { field: 'context.status', op: 'in', value: ['open', 'pending'] }),
    ).toBe(true);
    expect(evalCondition(ctx, { field: 'context.status', op: 'in', value: ['closed'] })).toBe(
      false,
    );
  });

  it('returns false for unknown op', () => {
    expect(evalCondition(ctx, { field: 'context.status', op: 'wat', value: 'open' })).toBe(false);
  });

  it('handles missing field gracefully', () => {
    expect(evalCondition(ctx, { field: 'context.nope.deep', op: 'eq', value: 'x' })).toBe(false);
  });
});

describe('evalAllConditions', () => {
  it('empty/null conditions always match', () => {
    expect(evalAllConditions({}, null)).toBe(true);
    expect(evalAllConditions({}, [])).toBe(true);
  });

  it('all must pass (AND)', () => {
    const ctx = { context: { p: 1, q: 'x' } };
    expect(
      evalAllConditions(ctx, [
        { field: 'context.p', op: 'eq', value: 1 },
        { field: 'context.q', op: 'contains', value: 'x' },
      ]),
    ).toBe(true);
    expect(
      evalAllConditions(ctx, [
        { field: 'context.p', op: 'eq', value: 1 },
        { field: 'context.q', op: 'eq', value: 'y' },
      ]),
    ).toBe(false);
  });
});

describe('processAutomationJob', () => {
  let requests: Array<{ collection?: string; payload?: unknown }>;
  let notifAdds: Array<{ name: string; data: unknown }>;
  let deps: AutomationDeps;
  let nextRules: AutomationRuleRow[];

  beforeEach(() => {
    requests = [];
    notifAdds = [];
    nextRules = [];
    const fakeDirectus = {
      request: vi.fn(async (cmd: unknown) => {
        const c = cmd as { _meta?: { kind: string; collection?: string; payload?: unknown } };
        // Our test stub commands carry _meta describing what they do.
        if (c._meta?.kind === 'readItems' && c._meta.collection === 'automation_rules') {
          return nextRules;
        }
        requests.push({ collection: c._meta?.collection, payload: c._meta?.payload });
        return { id: 'mock', ...(c._meta?.payload as object) };
      }),
    } as unknown as YijiDirectusClient;

    const notifQueue = {
      add: vi.fn(async (name: string, data: unknown) => {
        notifAdds.push({ name, data });
      }),
    } as unknown as Queue;
    const autoQueue = { add: vi.fn() } as unknown as Queue;

    deps = {
      directus: fakeDirectus,
      logger: noopLog,
      notificationsQueue: notifQueue,
      automationQueue: autoQueue,
    };
  });

  function makeJob(over: Partial<AutomationJob> = {}): Job<AutomationJob> {
    return {
      id: 'j1',
      name: 'auto',
      data: {
        triggerEvent: 'ticket_created',
        entity: { type: 'ticket', id: 't1' },
        context: { priority: 'high' },
        _depth: 0,
        ...over,
      },
    } as unknown as Job<AutomationJob>;
  }

  it('runs a matching rule and enqueues a notification', async () => {
    nextRules = [
      {
        id: 'r1',
        name: 'High → notify',
        trigger_event: 'ticket_created',
        conditions: [{ field: 'context.priority', op: 'eq', value: 'high' }],
        actions: [
          {
            kind: 'send_notification',
            params: { recipientId: 'u1', type: 'automation', title: 'A new high', body: 'go!' },
          },
        ],
        active: true,
        priority: 0,
        trigger_count: 0,
      },
    ];
    // Override directus.request to return rules on the first call (mock above).
    (deps.directus.request as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => nextRules,
    );
    await processAutomationJob(makeJob(), deps);
    expect(notifAdds).toHaveLength(1);
    expect(notifAdds[0]?.data).toMatchObject({ recipientId: 'u1', type: 'automation' });
  });

  it('skips actions when conditions do not match', async () => {
    nextRules = [
      {
        id: 'r2',
        name: 'Low only',
        trigger_event: 'ticket_created',
        conditions: [{ field: 'context.priority', op: 'eq', value: 'low' }],
        actions: [{ kind: 'send_notification', params: { recipientId: 'u1' } }],
        active: true,
        priority: 0,
        trigger_count: 0,
      },
    ];
    (deps.directus.request as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => nextRules,
    );
    await processAutomationJob(makeJob(), deps);
    expect(notifAdds).toHaveLength(0);
  });

  it('escalate action fires on a keyword match in context.message and notifies', async () => {
    nextRules = [
      {
        id: 'r-esc',
        name: 'Refund → escalate',
        trigger_event: 'message_received',
        conditions: [{ field: 'context.message', op: 'contains', value: 'refund' }],
        actions: [{ kind: 'escalate', params: { priority: 'urgent', recipientId: 'mgr1' } }],
        active: true,
        priority: 0,
        trigger_count: 0,
      },
    ];
    (deps.directus.request as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => nextRules,
    );
    await processAutomationJob(
      makeJob({
        triggerEvent: 'message_received',
        entity: { type: 'conversation', id: 'c1' },
        context: { message: 'I want a REFUND please' },
      }),
      deps,
    );
    // keyword matched (case-insensitive) → escalation notification enqueued
    expect(notifAdds).toHaveLength(1);
    expect(notifAdds[0]?.data).toMatchObject({ recipientId: 'mgr1', type: 'escalation' });
  });

  it('respects AUTOMATION_MAX_DEPTH and short-circuits', async () => {
    nextRules = [
      {
        id: 'r3',
        name: 'Always',
        trigger_event: 'ticket_created',
        conditions: null,
        actions: [{ kind: 'send_notification', params: { recipientId: 'u1' } }],
        active: true,
        priority: 0,
        trigger_count: 0,
      },
    ];
    (deps.directus.request as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => nextRules,
    );
    await processAutomationJob(makeJob({ _depth: AUTOMATION_MAX_DEPTH }), deps);
    // No directus call happened — short-circuited before reading rules.
    expect(deps.directus.request as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(notifAdds).toHaveLength(0);
  });
});
