import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { QUEUES, type AutomationJob } from '@yiji/shared-types';

/**
 * Side-effect job producer. Emits BullMQ jobs (automation, etc.) for the workers
 * service. When Redis is disabled (local single-instance dev) this is a no-op so
 * the gateway still runs — side effects are simply skipped.
 */
export interface SideEffectProducer {
  conversationCreated(conversationId: string): Promise<void>;
  messageReceived(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

class NoopProducer implements SideEffectProducer {
  constructor(private readonly logger: Logger) {}
  async conversationCreated(): Promise<void> {
    this.logger.debug('side-effect skipped (Redis disabled): conversation_created');
  }
  async messageReceived(): Promise<void> {
    this.logger.debug('side-effect skipped (Redis disabled): message_received');
  }
  async close(): Promise<void> {}
}

class BullProducer implements SideEffectProducer {
  private readonly automation: Queue;
  private readonly connection: Redis;
  constructor(redisUrl: string) {
    // Same auto-reconnect posture as the Socket.IO Redis clients.
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (attempts: number) => Math.min(attempts * 200, 5000),
    });
    this.connection.on('error', () => {
      /* swallow — retried by retryStrategy; logged once by BullMQ */
    });
    this.automation = new Queue(QUEUES.automation, { connection: this.connection });
  }
  async conversationCreated(conversationId: string): Promise<void> {
    const job: AutomationJob = {
      triggerEvent: 'conversation_created',
      entity: { type: 'conversation', id: conversationId },
      context: {},
      _depth: 0,
    };
    await this.automation.add('conversation_created', job);
  }
  async messageReceived(conversationId: string): Promise<void> {
    const job: AutomationJob = {
      triggerEvent: 'message_received',
      entity: { type: 'conversation', id: conversationId },
      context: {},
      _depth: 0,
    };
    await this.automation.add('message_received', job);
  }
  async close(): Promise<void> {
    await this.automation.close();
    await this.connection.quit();
  }
}

export function createProducer(
  opts: { redisEnabled: boolean; redisUrl: string },
  logger: Logger,
): SideEffectProducer {
  return opts.redisEnabled ? new BullProducer(opts.redisUrl) : new NoopProducer(logger);
}
