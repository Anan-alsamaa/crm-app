import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { NotificationJob } from '@yiji/shared-types';
import {
  notifyAssignment,
  assignmentJobId,
  buildAssignmentNotification,
  type AssignmentEntity,
  type AssignmentNotifyDeps,
} from '../src/assignment-notify.js';

/**
 * POST /jobs/notify-assignment — the notification an assignee gets when a
 * conversation/ticket is handed to them.
 *
 * The security property under test: ANY agent can call this, so the endpoint
 * must derive recipient + copy from the SERVER-fetched entity and ignore
 * anything else the client sends. Everything else here (self-assign, no
 * assignee, unauthenticated) is a "notify nobody" case.
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as AssignmentNotifyDeps['logger'];

const CALLER = 'agent-caller';
const ASSIGNEE = 'agent-assignee';

function makeDeps(entity: AssignmentEntity | null) {
  const enqueued: Array<{ job: NotificationJob; jobId: string }> = [];
  const deps: AssignmentNotifyDeps = {
    loadEntity: vi.fn(async () => entity),
    enqueueNotification: vi.fn(async (job: NotificationJob, jobId: string) => {
      enqueued.push({ job, jobId });
      return jobId;
    }),
    logger: silentLogger,
  };
  return { deps, enqueued };
}

beforeEach(() => vi.clearAllMocks());

describe('notifyAssignment — enqueues for a real assignee', () => {
  it('enqueues an assignment notification for a ticket', async () => {
    const { deps, enqueued } = makeDeps({
      id: 'tkt-1',
      assignedAgent: ASSIGNEE,
      label: 'Broken charger',
    });
    const out = await notifyAssignment(deps, { entityType: 'ticket', entityId: 'tkt-1' }, CALLER);

    expect(out.status).toBe('enqueued');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.job).toMatchObject({
      recipientId: ASSIGNEE,
      type: 'assignment',
      link: '/tickets/tkt-1',
    });
    expect(enqueued[0]!.job.body).toContain('Broken charger');
    // Deterministic id so a double-click can't spam the assignee.
    expect(enqueued[0]!.jobId).toBe('assign-ticket-tkt-1-agent-assignee');
  });

  it('enqueues for a conversation and deep-links into the inbox', async () => {
    const { deps, enqueued } = makeDeps({
      id: 'conv-9',
      assignedAgent: ASSIGNEE,
      label: 'Dana Ali',
    });
    const out = await notifyAssignment(
      deps,
      { entityType: 'conversation', entityId: 'conv-9' },
      CALLER,
    );

    expect(out.status).toBe('enqueued');
    expect(enqueued[0]!.job.link).toBe('/?conv=conv-9');
    expect(enqueued[0]!.job.body).toContain('Dana Ali');
    expect(enqueued[0]!.jobId).toBe('assign-conversation-conv-9-agent-assignee');
  });

  it('repeat calls reuse the same deterministic jobId (dedup, no spam)', async () => {
    const { deps, enqueued } = makeDeps({ id: 'tkt-2', assignedAgent: ASSIGNEE, label: null });
    await notifyAssignment(deps, { entityType: 'ticket', entityId: 'tkt-2' }, CALLER);
    await notifyAssignment(deps, { entityType: 'ticket', entityId: 'tkt-2' }, CALLER);
    expect(enqueued[0]!.jobId).toBe(enqueued[1]!.jobId);
  });
});

describe('notifyAssignment — cases that must notify nobody', () => {
  it('does NOT enqueue on self-assign', async () => {
    const { deps, enqueued } = makeDeps({ id: 'tkt-3', assignedAgent: CALLER, label: 'Mine' });
    const out = await notifyAssignment(deps, { entityType: 'ticket', entityId: 'tkt-3' }, CALLER);
    expect(out).toEqual({ status: 'skipped', reason: 'self-assign' });
    expect(deps.enqueueNotification).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(0);
  });

  it('does NOT enqueue when the entity is unassigned (null)', async () => {
    const { deps } = makeDeps({ id: 'conv-4', assignedAgent: null, label: 'Dana' });
    const out = await notifyAssignment(
      deps,
      { entityType: 'conversation', entityId: 'conv-4' },
      CALLER,
    );
    expect(out).toEqual({ status: 'skipped', reason: 'unassigned' });
    expect(deps.enqueueNotification).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the entity does not exist', async () => {
    const { deps } = makeDeps(null);
    const out = await notifyAssignment(deps, { entityType: 'ticket', entityId: 'nope' }, CALLER);
    expect(out).toEqual({ status: 'skipped', reason: 'not-found' });
    expect(deps.enqueueNotification).not.toHaveBeenCalled();
  });

  it('reports queue-disabled (no Redis) instead of pretending it enqueued', async () => {
    const deps: AssignmentNotifyDeps = {
      loadEntity: async () => ({ id: 'tkt-5', assignedAgent: ASSIGNEE, label: null }),
      enqueueNotification: async () => null,
      logger: silentLogger,
    };
    const out = await notifyAssignment(deps, { entityType: 'ticket', entityId: 'tkt-5' }, CALLER);
    expect(out.status).toBe('queue-disabled');
  });
});

describe('notifyAssignment — payload validation (anti-spam surface)', () => {
  it.each([
    ['unknown entity type', { entityType: 'invoice', entityId: 'x1' }],
    ['missing entityId', { entityType: 'ticket' }],
    ['non-string entityId', { entityType: 'ticket', entityId: 42 }],
    // ':' is BullMQ key material; the charset guard keeps it out of the jobId.
    ['id with a redis key delimiter', { entityType: 'ticket', entityId: 'a:b' }],
    ['no body at all', undefined],
  ])('rejects %s without touching Directus or the queue', async (_label, body) => {
    const { deps } = makeDeps({ id: 'tkt-6', assignedAgent: ASSIGNEE, label: null });
    const out = await notifyAssignment(deps, body, CALLER);
    expect(out.status).toBe('invalid');
    expect(deps.loadEntity).not.toHaveBeenCalled();
    expect(deps.enqueueNotification).not.toHaveBeenCalled();
  });

  it('IGNORES a client-supplied recipient/title/body/link — all are server-derived', async () => {
    const { deps, enqueued } = makeDeps({
      id: 'tkt-7',
      assignedAgent: ASSIGNEE,
      label: 'Refund request',
    });
    await notifyAssignment(
      deps,
      {
        entityType: 'ticket',
        entityId: 'tkt-7',
        // Everything below is the spam/phishing vector; none may survive.
        recipientId: 'victim-user',
        recipient: 'victim-user',
        type: 'sla_breach',
        title: 'Reset your password',
        body: 'Click http://evil.example to reset your password.',
        link: 'http://evil.example',
        payload: { evil: true },
      },
      CALLER,
    );

    const job = enqueued[0]!.job;
    expect(job.recipientId).toBe(ASSIGNEE);
    expect(job.type).toBe('assignment');
    expect(job.title).toBe('New ticket assigned to you');
    expect(job.body).not.toContain('evil.example');
    expect(job.link).toBe('/tickets/tkt-7');
    expect(job.payload).toEqual({ entityType: 'ticket', ticketId: 'tkt-7' });
    expect(enqueued[0]!.jobId).not.toContain('victim-user');
  });
});

describe('buildAssignmentNotification — copy fallbacks', () => {
  it('falls back to the id when a ticket has no subject', () => {
    const job = buildAssignmentNotification(
      'ticket',
      { id: 'tkt-8', assignedAgent: ASSIGNEE, label: '   ' },
      ASSIGNEE,
    );
    expect(job.body).toBe('Ticket tkt-8 was assigned to you.');
  });

  it('falls back to a generic line when a conversation has no contact name', () => {
    const job = buildAssignmentNotification(
      'conversation',
      { id: 'conv-8', assignedAgent: ASSIGNEE, label: null },
      ASSIGNEE,
    );
    expect(job.body).toBe('A conversation was assigned to you.');
  });

  it('builds hyphen-only job ids (BullMQ rejects ":")', () => {
    expect(assignmentJobId('conversation', 'c1', 'u1')).toBe('assign-conversation-c1-u1');
    expect(assignmentJobId('ticket', 't1', 'u1')).not.toContain(':');
  });
});

/**
 * Route-level wiring, mirroring index.ts: an unauthenticated (or non-staff)
 * caller must be rejected BEFORE any entity read or enqueue happens.
 */
describe('POST /jobs/notify-assignment — auth gate', () => {
  const STAFF_ROLES = new Set(['Admin', 'Administrator', 'Agent']);

  function buildApp(identityByToken: Record<string, { id: string; role: string | null }>) {
    const enqueue = vi.fn(async (_job: NotificationJob, jobId: string) => jobId);
    const loadEntity = vi.fn(async () => ({
      id: 'tkt-1',
      assignedAgent: ASSIGNEE,
      label: 'Subject',
    }));
    const app = Fastify();
    app.post('/jobs/notify-assignment', async (req, reply) => {
      const raw = req.headers['authorization'];
      const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      if (!token) return reply.code(401).send({ ok: false, error: 'missing bearer token' });
      const identity = identityByToken[token];
      if (!identity || !identity.role || !STAFF_ROLES.has(identity.role)) {
        return reply.code(403).send({ ok: false, error: 'agent role required' });
      }
      const out = await notifyAssignment(
        { loadEntity, enqueueNotification: enqueue, logger: silentLogger },
        req.body,
        identity.id,
      );
      if (out.status === 'invalid') return reply.code(400).send({ ok: false, error: out.error });
      if (out.status === 'skipped') return reply.send({ ok: true, enqueued: false });
      if (out.status === 'queue-disabled')
        return reply.code(503).send({ ok: false, error: 'queue disabled (no Redis)' });
      return reply.send({ ok: true, enqueued: true, jobId: out.jobId });
    });
    return { app, enqueue, loadEntity };
  }

  const payload = { entityType: 'ticket', entityId: 'tkt-1' };

  it('rejects an unauthenticated caller with 401 and enqueues nothing', async () => {
    const { app, enqueue, loadEntity } = buildApp({});
    const res = await app.inject({ method: 'POST', url: '/jobs/notify-assignment', payload });
    expect(res.statusCode).toBe(401);
    expect(loadEntity).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an invalid token with 403', async () => {
    const { app, enqueue } = buildApp({ good: { id: CALLER, role: 'Agent' } });
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/notify-assignment',
      headers: { authorization: 'Bearer forged' },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a service account (no app role) with 403', async () => {
    const { app, enqueue } = buildApp({ svc: { id: 'svc-1', role: 'svc-workers' } });
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/notify-assignment',
      headers: { authorization: 'Bearer svc' },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a plain Agent (not just admins) and enqueues for the assignee', async () => {
    const { app, enqueue } = buildApp({ tok: { id: CALLER, role: 'Agent' } });
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/notify-assignment',
      headers: { authorization: 'Bearer tok' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, enqueued: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0].recipientId).toBe(ASSIGNEE);
    await app.close();
  });

  it('answers a self-assign like a successful no-op (no entity info leaked)', async () => {
    const { app, enqueue } = buildApp({ tok: { id: ASSIGNEE, role: 'Agent' } });
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/notify-assignment',
      headers: { authorization: 'Bearer tok' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, enqueued: false });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const { app, enqueue } = buildApp({ tok: { id: CALLER, role: 'Agent' } });
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/notify-assignment',
      headers: { authorization: 'Bearer tok' },
      payload: { entityType: 'invoice', entityId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });
});
