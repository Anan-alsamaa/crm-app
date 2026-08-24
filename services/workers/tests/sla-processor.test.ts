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
  TeamRepo,
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

/** Team membership stub: teamId → member user ids. */
function makeTeams(members: Record<string, string[]> = {}): TeamRepo {
  return { listMemberIds: async (teamId) => members[teamId] ?? [] };
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
  it('survives an active policy that names no priorities', async () => {
    /*
     * The compensation clone ships active policies with a NULL
     * applies_to_priority. `Array.find` does not skip a predicate that throws —
     * it propagates — so dereferencing that null killed the whole sweep before
     * it reached the policy that matched, and NO ticket was ever stamped. The
     * visible damage was the entire SLA report showing a dash in every row and
     * zero breaches, while the sweep appeared to run normally.
     */
    const nullPriorities = {
      ...POLICY,
      id: 'p-null',
      name: 'Compensation clone',
      applies_to_priority: null,
    } as unknown as SlaPolicyRow;
    // Listed FIRST, so the broken one is reached before the good one.
    const { repo, patched } = makeRepo([{ ...baseTicket }], [nullPriorities, POLICY]);
    const q = makeQueues();

    await runReconcile({
      tickets: repo,
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    });

    // The usable policy still wins, and the deadlines still get written.
    expect(patched[0]?.patch.sla_policy).toBe('p1');
    expect(patched.some((p) => p.patch.resolution_due_at)).toBe(true);
  });

  it('holds a ticket to the most specific policy that covers it, not the first row back', async () => {
    /*
     * With four coverage dimensions, several policies matching one ticket is
     * the normal case rather than the edge case. The old `find` took whichever
     * row Directus happened to return first, so the promise a ticket was held
     * to depended on row order — the same ticket could change deadline between
     * two sweeps with nothing having been edited.
     */
    const broad: SlaPolicyRow = { ...POLICY, id: 'broad', name: 'All tickets' };
    const narrow: SlaPolicyRow = {
      ...POLICY,
      id: 'narrow',
      name: 'Roach, Herfy',
      applies_to_type: ['Roach found'],
      applies_to_brand: ['Herfy'],
      first_response_minutes: 5,
    };
    const ticket: TicketRow = {
      ...baseTicket,
      complaint_type: 'Roach found',
      store_snapshot: { brandName: 'Herfy' },
    };

    for (const order of [
      [broad, narrow],
      [narrow, broad],
    ]) {
      const { repo, patched } = makeRepo([{ ...ticket }], order);
      const q = makeQueues();
      await runReconcile({
        tickets: repo,
        teams: makeTeams(),
        slaQueue: q.slaQueue,
        notificationsQueue: q.notificationsQueue,
        logger,
      });
      expect(patched[0]?.patch.sla_policy).toBe('narrow');
    }
  });

  it('does not hold a ticket to a policy whose coverage it misses', async () => {
    const brandOnly: SlaPolicyRow = { ...POLICY, id: 'kudu', applies_to_brand: ['Kudu'] };
    const { repo, patched } = makeRepo(
      [{ ...baseTicket, store_snapshot: { brandName: 'Herfy' } }],
      [brandOnly],
    );
    const q = makeQueues();
    await runReconcile({
      tickets: repo,
      teams: makeTeams(),
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    });
    expect(patched).toEqual([]);
    expect(q.sla).toEqual([]);
  });

  it('counts the deadline in working hours, not through the night', async () => {
    /*
     * 16:00 on a Sunday plus a 4-hour target. Round the clock that is 20:00 the
     * same evening, breached against a branch that shut at 17:00. Under working
     * hours only the last hour of Sunday counts, so it is due at 12:00 on
     * Monday — and the warning lands inside Monday morning rather than at some
     * point on the closed Sunday evening.
     */
    const officeHours: SlaPolicyRow = {
      ...POLICY,
      id: 'office',
      resolution_minutes: 240,
      business_hours: {
        timezone: 'UTC',
        days: Object.fromEntries(
          [0, 1, 2, 3, 4].map((d) => [String(d), [['09:00', '17:00'] as [string, string]]]),
        ),
      },
    };
    const raisedAt = new Date('2026-06-07T16:00:00Z');
    const { repo, patched } = makeRepo(
      [{ ...baseTicket, date_created: raisedAt.toISOString() }],
      [officeHours],
    );
    const q = makeQueues();
    // The queue delays are measured from NOW, so the clock has to sit at the
    // moment the ticket was raised for them to mean anything.
    vi.useFakeTimers();
    vi.setSystemTime(raisedAt);
    try {
      await runReconcile({
        tickets: repo,
        teams: makeTeams(),
        slaQueue: q.slaQueue,
        notificationsQueue: q.notificationsQueue,
        logger,
      });
    } finally {
      vi.useRealTimers();
    }

    const due = patched.find((p) => p.patch.resolution_due_at)?.patch.resolution_due_at;
    expect(due).toBe(new Date('2026-06-08T12:00:00Z').toISOString());

    // 80% of 240 WORKED minutes = 192, which is 11:12 Monday — inside the
    // working day. Wall-clock interpolation between 16:00 Sunday and 12:00
    // Monday would have put the warning at 00:00, with nobody there to act.
    const warn = q.sla.find(
      (j) => j.name === 'warning' && (j.data as { deadline: string }).deadline === 'resolution',
    );
    const delay = (warn?.opts as { delay: number }).delay;
    expect(new Date(raisedAt.getTime() + delay).toISOString()).toBe('2026-06-08T11:12:00.000Z');
  });

  it('lets one unusable policy cost only its own tickets', async () => {
    /*
     * `computeDueAt` throws when working hours have no open window. Unguarded,
     * that aborted the sweep for every ticket behind it in the list — the same
     * shape of failure as the null-priority crash above, and the reason this
     * feature has twice gone completely silent rather than partially wrong.
     */
    const closedForever: SlaPolicyRow = {
      ...POLICY,
      id: 'closed',
      applies_to_type: ['Late order'],
      business_hours: { timezone: 'UTC', days: {} },
    };
    const { repo, patched } = makeRepo(
      [
        { ...baseTicket, id: 'broken', complaint_type: 'Late order' },
        { ...baseTicket, id: 'fine' },
      ],
      [closedForever, POLICY],
    );
    const q = makeQueues();
    await runReconcile({
      tickets: repo,
      teams: makeTeams(),
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    });

    expect(patched.some((p) => p.id === 'fine' && p.patch.resolution_due_at)).toBe(true);
    expect(patched.some((p) => p.id === 'broken' && p.patch.resolution_due_at)).toBe(false);
  });

  it('gives a ticket a RESOLUTION deadline only, and schedules its two jobs', async () => {
    /*
     * A ticket used to get a first-response deadline too, and that clock could
     * never be stopped: nothing in this product writes
     * `tickets.first_responded_at` — every reference is a read. Measured on
     * live data, six tickets carried the deadline, one first reply was ever
     * recorded, and all six sat permanently breached, drowning the resolution
     * breach beside them.
     *
     * It was also the wrong object. A ticket is raised out of a conversation an
     * agent has already answered, so a first response timed from the ticket's
     * creation re-judges a reply made before the ticket existed. First response
     * belongs to the CHAT; a ticket's promise is how long it takes to SOLVE.
     */
    const { repo, patched } = makeRepo([{ ...baseTicket }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(),
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runReconcile(deps);

    expect(patched[0]?.patch.sla_policy).toBe('p1');
    const due = patched.find((p) => p.patch.resolution_due_at);
    expect(due?.patch.resolution_due_at).toBeTruthy();
    expect(patched.every((p) => p.patch.first_response_due_at === undefined)).toBe(true);

    // Two jobs, not four: a warning and a breach, for resolution alone.
    const ids = q.sla.map((j) => (j.opts as { jobId: string }).jobId).sort();
    expect(ids).toEqual(['t1-resolution-breach', 't1-resolution-warning']);
  });

  it('skips first-response warning when ticket has already been responded to', async () => {
    const t = { ...baseTicket, first_responded_at: new Date().toISOString() };
    const { repo } = makeRepo([t], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(),
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
      teams: makeTeams(),
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
      teams: makeTeams(),
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
    expect(q.notifications[0]?.opts?.jobId).toBe('slanotif-sla_warning-t1-first_response-user-1');
  });

  it('writes sla_breached event + enqueues a sla_breach notification', async () => {
    const { repo, events } = makeRepo([{ ...baseTicket }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(),
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
    expect(q.notifications[0]?.opts?.jobId).toBe('slanotif-sla_breach-t1-resolution-user-1');
  });

  it('no-op when first-response warning fires after the agent has already responded', async () => {
    const responded = { ...baseTicket, first_responded_at: new Date().toISOString() };
    const { repo, events } = makeRepo([responded], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(),
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
      teams: makeTeams(),
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runBreach(deps, 't1', 'first_response');
    expect(events).toEqual([]);
  });
});

describe('runBreach escalation (FR-017)', () => {
  function setup(ticket: TicketRow = { ...baseTicket }, members: Record<string, string[]> = {}) {
    const { repo, patched, events } = makeRepo([ticket], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(members),
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
    // Team with the assignee as its only member: the fanout must not duplicate.
    const { deps, q } = setup(
      { ...baseTicket, priority: 'low', assigned_team: 'team-9' },
      {
        'team-9': ['user-1'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    const types = q.notifications.map((n) => (n.data as { type: string }).type);
    expect(types).toEqual(['sla_breach', 'escalation']);
    const esc = q.notifications[1]!;
    expect(esc.opts?.jobId).toBe('slanotif-escalation-t1-resolution-user-1');
    expect((esc.data as { payload: Record<string, unknown> }).payload).toMatchObject({
      ticketId: 't1',
      deadline: 'resolution',
      reason: 'sla_breach',
      fromPriority: 'low',
      toPriority: 'urgent',
      team: 'team-9',
      isAssignee: true,
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

  it('escalates an unassigned, teamless ticket without enqueuing notifications', async () => {
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

describe('escalation fans out to the assigned team', () => {
  function setup(ticket: TicketRow, members: Record<string, string[]> = {}) {
    const { repo, events } = makeRepo([ticket], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams(members),
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    return { deps, events, q };
  }

  const recipientsOf = (q: ReturnType<typeof makeQueues>, type: string) =>
    q.notifications
      .filter((n) => (n.data as { type: string }).type === type)
      .map((n) => (n.data as { recipientId: string }).recipientId);

  it('pages every teammate on escalation, not just the assignee', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-1', 'user-2', 'user-3'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    expect(recipientsOf(q, 'escalation')).toEqual(['user-1', 'user-2', 'user-3']);
    // Each teammate needs their own dedup key or BullMQ collapses them into one job.
    const ids = q.notifications
      .filter((n) => (n.data as { type: string }).type === 'escalation')
      .map((n) => n.opts?.jobId);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps the plain breach notice owner-only', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-1', 'user-2', 'user-3'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    // The breach reports THIS agent's miss; broadcasting it is noise.
    expect(recipientsOf(q, 'sla_breach')).toEqual(['user-1']);
  });

  it('marks teammates as non-assignees so the portal can word it differently', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-1', 'user-2'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    const flags = q.notifications
      .filter((n) => (n.data as { type: string }).type === 'escalation')
      .map((n) => (n.data as { payload: { isAssignee: boolean } }).payload.isAssignee);
    expect(flags).toEqual([true, false]);
  });

  it('pages the team when the breached ticket has NO assignee (previously silent)', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_agent: null, assigned_team: 'team-9' },
      {
        'team-9': ['user-2', 'user-3'],
      },
    );
    await runBreach(deps, 't1', 'first_response');

    // No owner, so no owner-only breach notice — but the team still gets paged.
    expect(recipientsOf(q, 'sla_breach')).toEqual([]);
    expect(recipientsOf(q, 'escalation')).toEqual(['user-2', 'user-3']);
  });

  it('dedups an assignee who is also listed as a team member', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-2', 'user-1'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    expect(recipientsOf(q, 'escalation')).toEqual(['user-1', 'user-2']);
  });

  it('still escalates when the team read fails — agent notified, breach not lost', async () => {
    const { repo, events } = makeRepo([{ ...baseTicket, assigned_team: 'team-9' }], [POLICY]);
    const q = makeQueues();
    const deps: SlaDeps = {
      tickets: repo,
      teams: {
        listMemberIds: async () => {
          throw new Error('directus 403');
        },
      },
      slaQueue: q.slaQueue,
      notificationsQueue: q.notificationsQueue,
      logger,
    };
    await runBreach(deps, 't1', 'resolution');

    // Priority bump + audit are load-bearing; they must survive a fanout failure.
    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
    expect(recipientsOf(q, 'escalation')).toEqual(['user-1']);
  });

  it('tells a teammate to act, not just that something happened', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-1', 'user-2'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    const bodies = q.notifications
      .filter((n) => (n.data as { type: string }).type === 'escalation')
      .map((n) => (n.data as { body: string }).body);
    expect(bodies[0]).toContain('The ticket has been escalated.');
    expect(bodies[1]).toContain('pick it up if the assignee cannot');
  });

  it('asks an unassigned ticket’s team to pick it up outright', async () => {
    const { deps, q } = setup(
      { ...baseTicket, assigned_agent: null, assigned_team: 'team-9' },
      {
        'team-9': ['user-2'],
      },
    );
    await runBreach(deps, 't1', 'resolution');

    expect((q.notifications[0]?.data as { body: string }).body).toContain(
      'unassigned and unanswered on your team — please pick it up',
    );
  });

  it('one failing recipient does not cost the rest of the team their page', async () => {
    const { repo } = makeRepo([{ ...baseTicket, assigned_team: 'team-9' }], [POLICY]);
    const notifications: Array<{ data: unknown }> = [];
    const notificationsQueue = {
      // user-2's enqueue fails the way a transient Redis blip would.
      add: vi.fn(async (_name, data: { recipientId: string }) => {
        if (data.recipientId === 'user-2') throw new Error('redis unavailable');
        notifications.push({ data });
      }),
    } as unknown as Queue;
    const deps: SlaDeps = {
      tickets: repo,
      teams: makeTeams({ 'team-9': ['user-1', 'user-2', 'user-3'] }),
      slaQueue: makeQueues().slaQueue,
      notificationsQueue,
      logger,
    };
    await runBreach(deps, 't1', 'resolution');

    // Without isolation the throw would abort the loop, and the retry would hit
    // the already-escalated guard and never page user-3 at all.
    const got = notifications.map((n) => (n.data as { recipientId: string }).recipientId);
    expect(got).toContain('user-3');
    expect(got).not.toContain('user-2');
  });

  it('is still idempotent across a retry with a team attached', async () => {
    const { deps, q, events } = setup(
      { ...baseTicket, assigned_team: 'team-9' },
      {
        'team-9': ['user-1', 'user-2'],
      },
    );
    await runBreach(deps, 't1', 'resolution');
    await runBreach(deps, 't1', 'resolution');

    expect(events.map((e) => e.type)).toEqual(['sla_breached', 'sla_escalated']);
    expect(q.notifications).toHaveLength(3); // 1 breach + 2 escalations
  });
});

describe('runReconcile — a policy cannot promise backwards', () => {
  it('does not attach a policy to a ticket raised before the policy existed', async () => {
    /*
     * Measured on live data the day the two policies were written: the ticket
     * policy immediately took six tickets raised one to two WEEKS earlier and
     * marked all six breached, none met — a resolution SLA reporting 0% when it
     * had never had the chance to measure anything. Nobody could have known
     * about a promise that did not exist yet.
     */
    const old = { ...baseTicket, id: 'old', date_created: '2026-08-11T22:53:49.000Z' };
    const { repo, patched } = makeRepo(
      [old],
      [{ ...POLICY, date_created: '2026-08-24T09:58:07.000Z' }],
    );
    const q = makeQueues();
    await runReconcile({ tickets: repo, teams: makeTeams(), ...q, logger });
    expect(patched).toHaveLength(0);
    expect(q.sla).toHaveLength(0);
  });

  it('still governs a ticket raised after it', async () => {
    const fresh = { ...baseTicket, id: 'fresh', date_created: '2026-08-25T08:00:00.000Z' };
    const { repo, patched } = makeRepo(
      [fresh],
      [{ ...POLICY, date_created: '2026-08-24T09:58:07.000Z' }],
    );
    const q = makeQueues();
    await runReconcile({ tickets: repo, teams: makeTeams(), ...q, logger });
    expect(patched.some((p) => p.patch.sla_policy === POLICY.id)).toBe(true);
    expect(patched.some((p) => p.patch.resolution_due_at)).toBe(true);
  });

  it('keeps honouring a policy already attached, even to an older ticket', async () => {
    // The check guards ATTACHMENT. A ticket that already carries a policy was
    // promised something, and moving the goalposts under it afterwards would be
    // the same retroactive change in the other direction.
    const old = {
      ...baseTicket,
      id: 'attached',
      date_created: '2026-08-11T22:53:49.000Z',
      sla_policy: POLICY.id,
    };
    const { repo, patched } = makeRepo(
      [old],
      [{ ...POLICY, date_created: '2026-08-24T09:58:07.000Z' }],
    );
    const q = makeQueues();
    await runReconcile({ tickets: repo, teams: makeTeams(), ...q, logger });
    expect(patched.some((p) => p.patch.resolution_due_at)).toBe(true);
  });
});

describe('runWarning — warns once, not once a minute', () => {
  it('does not re-warn on a later sweep', async () => {
    /*
     * The reconcile re-adds the warning job every 60s with a stable jobId, and
     * BullMQ only rejects a duplicate id while the job still EXISTS — these are
     * added with removeOnComplete. So the job ran, deleted itself, and was
     * re-added to an empty queue a minute later. For an already-overdue ticket
     * the delay is zero, which made it a loop.
     *
     * Measured on live data before this ledger existed: 20,397 sla_warning rows
     * across SIX tickets, still growing by six a minute four days on — burying
     * the append-only trail that field history is derived from.
     */
    const t = { ...baseTicket, id: 'warn-once' };
    const { repo, events } = makeRepo([t], [POLICY]);
    const q = makeQueues();
    const deps = { tickets: repo, teams: makeTeams(), ...q, logger };

    await runWarning(deps, t.id, 'resolution');
    await runWarning(deps, t.id, 'resolution');
    await runWarning(deps, t.id, 'resolution');

    expect(events.filter((e) => e.type === 'sla_warning')).toHaveLength(1);
    expect(q.notifications.filter((n) => n.name === 'sla_warning')).toHaveLength(1);
  });

  it('still warns separately for a different deadline on the same ticket', async () => {
    // The two deadlines are independent promises; silencing one must not
    // silence the other.
    const t = { ...baseTicket, id: 'warn-both' };
    const { repo, events } = makeRepo([t], [POLICY]);
    const q = makeQueues();
    const deps = { tickets: repo, teams: makeTeams(), ...q, logger };

    await runWarning(deps, t.id, 'resolution');
    await runWarning(deps, t.id, 'first_response');

    expect(events.filter((e) => e.type === 'sla_warning')).toHaveLength(2);
  });
});
