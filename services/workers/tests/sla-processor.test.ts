import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  runReconcile,
  runWarning,
  runBreach,
  ESCALATED_PRIORITY,
  type SlaDeps,
} from '../src/processors/sla.js';
import type {
  TicketRepo,
  TicketRow,
  SlaPolicyRow,
  TicketEventType,
} from '../src/processors/repos.js';

function makeRepo(tickets: TicketRow[], policies: SlaPolicyRow[]) {
  const patched: Array<{ id: string; patch: Partial<TicketRow> }> = [];
  const events: Array<{ ticket: string; type: TicketEventType; payload?: unknown }> = [];
  const repo: TicketRepo = {
    listOpenTickets: async () => tickets,
    listActiveSlaPolicies: async () => policies,
    getTicket: async (id) => tickets.find((t) => t.id === id) ?? null,
    patchTicket: async (id, patch) => {
      patched.push({ id, patch });
      Object.assign(tickets.find((t) => t.id === id) ?? {}, patch);
    },
    createTicketEvent: async (ticketId, type, payload) => {
      events.push({ ticket: ticketId, type, payload });
    },
    // Append-only event log, read back for the breach idempotency guard.
    listTicketEvents: async (ticketId, type) =>
      events
        .filter((e) => e.ticket === ticketId && (!type || e.type === type))
        .map((e) => ({
          event_type: e.type,
          payload: (e.payload as Record<string, unknown> | undefined) ?? null,
        })),
  };
  return { repo, patched, events };
}

function makeQueues() {
  const sla: Array<{ name: string; data: unknown; opts: unknown }> = [];
  const notifications: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];
  const slaQueue = {
    add: vi.fn(async (name, data, opts) => sla.push({ name, data, opts })),
  } as unknown as Queue;
  const notificationsQueue = {
    add: vi.fn(async (name, data, opts) => notifications.push({ name, data, opts })),
  } as unknown as Queue;
  return { slaQueue, notificationsQueue, sla, notifications };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const POLICY: SlaPolicyRow = {
  id: 'p1',
  name: 'Default',
  applies_to_priority: ['low', 'medium', 'high', 'urgent'],
  first_response_minutes: 30,
  resolution_minutes: 240,
  warning_threshold_percent: 80,
  business_hours: null,
  active: true,
};

const baseTicket: TicketRow = {
  id: 't1',
  status: 'open',
  priority: 'high',
  sla_policy: null,
  first_response_due_at: null,
  resolution_due_at: null,
  first_responded_at: null,
  resolved_at: null,
  closed_at: null,
  assigned_agent: 'user-1',
  assigned_team: null,
  date_created: new Date('2026-06-01T10:00:00Z').toISOString(),
};

describe('runReconcile (T067)', () => {
  it('assigns SLA policy by priority + computes due dates + schedules 4 jobs', async () => {
    const { repo, patched } = makeRepo([{ ...baseTicket }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runReconcile(deps);

    // Policy attached, due dates computed.
    expect(patched.find((p) => p.patch.sla_policy === 'p1')).toBeTruthy();
    expect(
      patched.find(
        (p) =>
          p.patch.first_response_due_at !== undefined && p.patch.resolution_due_at !== undefined,
      ),
    ).toBeTruthy();
    // 2 warnings + 2 breaches enqueued (first-response + resolution).
    expect(q.slaQueue.add).toHaveBeenCalledTimes(4);
    const ids = q.sla.map((j) => (j.opts as { jobId: string }).jobId).sort();
    expect(ids).toEqual([
      't1-first_response-breach',
      't1-first_response-warning',
      't1-resolution-breach',
      't1-resolution-warning',
    ]);
  });

  it('skips first-response warning when ticket has already been responded to', async () => {
    const t = { ...baseTicket, first_responded_at: new Date().toISOString() };
    const { repo } = makeRepo([t], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runReconcile(deps);
    const ids = q.sla.map((j) => (j.opts as { jobId: string }).jobId).sort();
    expect(ids).toEqual(['t1-resolution-breach', 't1-resolution-warning']);
  });

  it('skips resolved or closed tickets entirely', async () => {
    const { repo } = makeRepo([{ ...baseTicket, status: 'closed' }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runReconcile(deps);
    expect(q.slaQueue.add).not.toHaveBeenCalled();
  });
});

describe('runWarning + runBreach (T067)', () => {
  it('writes sla_warning event + enqueues a sla_warning notification', async () => {
    const { repo, events } = makeRepo([{ ...baseTicket }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runWarning(deps, 't1', 'first_response');
    expect(events).toEqual([
      { ticket: 't1', type: 'sla_warning', payload: { deadline: 'first_response' } },
    ]);
    expect(q.notifications).toHaveLength(1);
    expect((q.notifications[0]?.data as { type: string }).type).toBe('sla_warning');
    // Deterministic jobId so a retry / stalled re-run doesn't double-notify.
    expect(q.notifications[0]?.opts?.jobId).toBe('slanotif-sla_warning-t1-first_response');
  });

  it('writes sla_breached event + enqueues a sla_breach notification', async () => {
    const { repo, events } = makeRepo([{ ...baseTicket }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runBreach(deps, 't1', 'resolution');
    expect(events[0]).toEqual({
      ticket: 't1',
      type: 'sla_breached',
      payload: { deadline: 'resolution' },
    });
    expect((q.notifications[0]?.data as { type: string }).type).toBe('sla_breach');
    expect(q.notifications[0]?.opts?.jobId).toBe('slanotif-sla_breach-t1-resolution');
  });

  it('no-op when first-response warning fires after the agent has already responded', async () => {
    const responded = { ...baseTicket, first_responded_at: new Date().toISOString() };
    const { repo, events } = makeRepo([responded], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runWarning(deps, 't1', 'first_response');
    expect(events).toEqual([]);
    expect(q.notifications).toHaveLength(0);
  });

  it('no-op on resolved tickets', async () => {
    const closed = { ...baseTicket, status: 'resolved' as const };
    const { repo, events } = makeRepo([closed], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runBreach(deps, 't1', 'first_response');
    expect(events).toEqual([]);
  });
});

describe('runBreach escalation (FR-017)', () => {
  function setup(ticket: TicketRow = { ...baseTicket }) {
    const { repo, patched, events } = makeRepo([ticket], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    return { deps, patched, events, q, ticket };
  }

  it('escalates the ticket to urgent and records an sla_escalated event', async () => {
    const { deps, patched, events } = setup({ ...baseTicket, priority: 'medium' });
    await runBreach(deps, 't1', 'first_response');

    expect(patched).toEqual([{ id: 't1', patch: { priority: ESCALATED_PRIORITY } }]);
    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
    expect(events[1]?.payload).toMatchObject({
      deadline: 'first_response',
      reason: 'sla_breach',
      from_priority: 'medium',
      to_priority: 'urgent',
    });
  });

  it('notifies the assigned agent with a distinct escalation notification', async () => {
    const { deps, q } = setup({ ...baseTicket, priority: 'low', assigned_team: 'team-9' });
    await runBreach(deps, 't1', 'resolution');

    const types = q.notifications.map((n) => (n.data as { type: string }).type);
    expect(types).toEqual(['sla_breach', 'escalation']);
    const esc = q.notifications[1]!;
    expect(esc.opts?.jobId).toBe('slanotif-escalation-t1-resolution');
    expect((esc.data as { payload: Record<string, unknown> }).payload).toMatchObject({
      ticketId: 't1',
      deadline: 'resolution',
      reason: 'sla_breach',
      fromPriority: 'low',
      toPriority: 'urgent',
      team: 'team-9',
    });
  });

  it('is idempotent — a retried breach job does not double-escalate', async () => {
    const { deps, patched, events, q } = setup({ ...baseTicket, priority: 'medium' });
    await runBreach(deps, 't1', 'first_response');
    await runBreach(deps, 't1', 'first_response');
    await runBreach(deps, 't1', 'first_response');

    expect(patched).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
    expect(q.notifications).toHaveLength(2);
  });

  it('escalates each deadline independently', async () => {
    const { deps, events } = setup({ ...baseTicket, priority: 'medium' });
    await runBreach(deps, 't1', 'first_response');
    await runBreach(deps, 't1', 'resolution');

    const escalations = events.filter((e) => e.type === 'sla_escalated');
    expect(escalations.map((e) => (e.payload as { deadline: string }).deadline)).toEqual([
      'first_response',
      'resolution',
    ]);
  });

  it('skips the priority patch when the ticket is already urgent, but still audits', async () => {
    const { deps, patched, events } = setup({ ...baseTicket, priority: 'urgent' });
    await runBreach(deps, 't1', 'resolution');

    expect(patched).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
  });

  it('escalates an unassigned ticket without enqueuing notifications', async () => {
    const { deps, patched, events, q } = setup({
      ...baseTicket,
      priority: 'high',
      assigned_agent: null,
    });
    await runBreach(deps, 't1', 'resolution');

    expect(patched).toEqual([{ id: 't1', patch: { priority: 'urgent' } }]);
    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
    expect(q.notifications).toHaveLength(0);
  });
});
