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
