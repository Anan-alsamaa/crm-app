import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bullmq + ioredis so the BullProducer path is exercised without a live
// Redis. We capture the constructed Queue so we can assert the emitted jobs.
const queueAdd = vi.fn(async () => undefined);
const queueClose = vi.fn(async () => undefined);
const redisQuit = vi.fn(async () => undefined);
const redisOn = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: queueAdd,
    close: queueClose,
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ on: redisOn, quit: redisQuit })),
}));

import { createProducer } from '../src/queue.js';
import { QUEUES } from '@yiji/shared-types';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: vi.fn(),
} as never;

beforeEach(() => {
  queueAdd.mockClear();
  queueClose.mockClear();
  redisQuit.mockClear();
});

describe('createProducer — NoopProducer (Redis disabled)', () => {
  it('skips side-effects without throwing', async () => {
    const p = createProducer({ redisEnabled: false, redisUrl: 'redis://x' }, silentLogger);
    await expect(p.conversationCreated('c-1')).resolves.toBeUndefined();
    await expect(p.messageReceived('c-1')).resolves.toBeUndefined();
    await expect(p.close()).resolves.toBeUndefined();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe('createProducer — BullProducer (Redis enabled)', () => {
  it('enqueues a conversation_created automation job', async () => {
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    await p.conversationCreated('conv-7');
    expect(queueAdd).toHaveBeenCalledWith(
      'conversation_created',
      expect.objectContaining({
        triggerEvent: 'conversation_created',
        entity: { type: 'conversation', id: 'conv-7' },
        _depth: 0,
      }),
    );
  });

  it('enqueues a message_received automation job', async () => {
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    await p.messageReceived('conv-8');
    expect(queueAdd).toHaveBeenCalledWith(
      'message_received',
      expect.objectContaining({ triggerEvent: 'message_received' }),
    );
  });

  it('enqueues an assignment notification with a deterministic jobId', async () => {
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    queueAdd.mockResolvedValueOnce({ id: 'assign-ticket-tkt-1-agent-2' } as never);
    const id = await p.enqueueNotification(
      {
        recipientId: 'agent-2',
        type: 'assignment',
        title: 'New ticket assigned to you',
        body: 'Ticket "Broken charger" was assigned to you.',
        link: '/tickets/tkt-1',
      },
      'assign-ticket-tkt-1-agent-2',
    );
    expect(id).toBe('assign-ticket-tkt-1-agent-2');
    expect(queueAdd).toHaveBeenCalledWith(
      'assignment',
      expect.objectContaining({ recipientId: 'agent-2', type: 'assignment' }),
      expect.objectContaining({ jobId: 'assign-ticket-tkt-1-agent-2' }),
    );
  });

  it('gives each ladder wake-up its OWN job id, so a re-arm is never swallowed', async () => {
    /*
     * THE FAULT THAT LET A CUSTOMER WAIT FOR EVER.
     *
     * The id was `route-assign-<conversation>`, fixed for the life of the chat,
     * and BullMQ IGNORES an add() whose id already exists — completed or not.
     * So the ladder could be armed exactly once per conversation, ever.
     *
     * Measured in production: conversation aa581e1a ran its ladder at 06:16:50,
     * the customer wrote again at 12:32:15, and the worker logged nothing at
     * all — not even "standing down". The job never existed. The producer
     * reported success while queueing nothing, which is why it was invisible.
     */
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    const arm = () => {
      // The real Queue resolves the created job; the shared stub resolves
      // undefined, which `added.id` cannot read.
      queueAdd.mockResolvedValueOnce({ id: 'queued' } as never);
      return p.enqueueRouting({
        conversationId: 'conv-9',
        stage: 'assign',
        attemptedAgentIds: [],
        outboundCountAtSchedule: 0,
      });
    };

    await arm();
    // A later wake-up for the SAME conversation, as a returning customer causes.
    await new Promise((r) => setTimeout(r, 2));
    await arm();

    const ids = queueAdd.mock.calls
      .filter((c) => c[0] === 'assign')
      .map((c) => (c[2] as { jobId?: string } | undefined)?.jobId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^route-assign-conv-9-\d+$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('keeps ONE stable id for reclaim, which is a grace period not a re-arm', async () => {
    // An agent whose network flaps three times in a minute must leave one
    // pending reclaim per conversation, not three racing handovers.
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    const reclaim = () => {
      queueAdd.mockResolvedValueOnce({ id: 'queued' } as never);
      return p.enqueueRouting({
        conversationId: 'conv-10',
        stage: 'reclaim',
        previousAgentId: 'agent-1',
        attemptedAgentIds: [],
        outboundCountAtSchedule: 0,
      });
    };

    await reclaim();
    await new Promise((r) => setTimeout(r, 2));
    await reclaim();

    const ids = queueAdd.mock.calls
      .filter((c) => c[0] === 'reclaim')
      .map((c) => (c[2] as { jobId?: string } | undefined)?.jobId);
    expect(ids).toEqual(['route-reclaim-conv-10', 'route-reclaim-conv-10']);
  });

  it('NoopProducer returns null for notifications (Redis disabled)', async () => {
    const p = createProducer({ redisEnabled: false, redisUrl: 'redis://x' }, silentLogger);
    await expect(
      p.enqueueNotification(
        { recipientId: 'a', type: 'assignment', title: 't', body: 'b' },
        'assign-ticket-1-a',
      ),
    ).resolves.toBeNull();
  });

  it('uses the automation queue and tears down on close', async () => {
    const p = createProducer(
      { redisEnabled: true, redisUrl: 'redis://localhost:6379' },
      silentLogger,
    );
    const { Queue } = await import('bullmq');
    expect(Queue).toHaveBeenCalledWith(QUEUES.automation, expect.any(Object));
    await p.close();
    expect(queueClose).toHaveBeenCalled();
    expect(redisQuit).toHaveBeenCalled();
  });
});
