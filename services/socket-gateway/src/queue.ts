import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  QUEUES,
  DEFAULT_JOB_OPTIONS,
  type AutomationJob,
  type ImportJob,
  type ReportJob,
} from '@yiji/shared-types';

/**
 * Side-effect job producer. Emits BullMQ jobs (automation, etc.) for the workers
 * service. When Redis is disabled (local single-instance dev) this is a no-op so
 * the gateway still runs — side effects are simply skipped.
 */
export interface SideEffectProducer {
  conversationCreated(conversationId: string): Promise<void>;
  /** `content` is carried into the automation context so keyword rules
   *  (condition `{field: 'context.message', op: 'contains', ...}`) can match. */
  messageReceived(conversationId: string, content?: string): Promise<void>;
  /** Admin-triggered: enqueue a contact CSV import. Returns the BullMQ job id,
   *  or null when the queue is disabled (no Redis) so callers can surface 503. */
  enqueueImport(job: ImportJob): Promise<string | null>;
  /** Admin-triggered: enqueue a "run now" for a saved report. */
  enqueueReport(job: ReportJob): Promise<string | null>;
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
  async enqueueImport(): Promise<string | null> {
    this.logger.warn('enqueue import skipped (Redis disabled)');
    return null;
  }
  async enqueueReport(): Promise<string | null> {
    this.logger.warn('enqueue report skipped (Redis disabled)');
    return null;
  }
  async close(): Promise<void> {}
}

class BullProducer implements SideEffectProducer {
  private readonly automation: Queue;
  private readonly imports: Queue;
  private readonly reports: Queue;
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
    // Admin-triggered enqueue (imports/reports) lands on the same queues the
    // workers consume — the job NAME is cosmetic; the queue + data shape match.
    this.imports = new Queue(QUEUES.imports, { connection: this.connection });
    this.reports = new Queue(QUEUES.reports, { connection: this.connection });
  }
  async enqueueImport(job: ImportJob): Promise<string | null> {
    const added = await this.imports.add('import', job, DEFAULT_JOB_OPTIONS);
    return added.id ?? null;
  }
  async enqueueReport(job: ReportJob): Promise<string | null> {
    const added = await this.reports.add('run-now', job, DEFAULT_JOB_OPTIONS);
    return added.id ?? null;
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
  async messageReceived(conversationId: string, content?: string): Promise<void> {
    const job: AutomationJob = {
      triggerEvent: 'message_received',
      entity: { type: 'conversation', id: conversationId },
      context: content ? { message: content } : {},
      _depth: 0,
    };
    await this.automation.add('message_received', job);
  }
  async close(): Promise<void> {
    await this.automation.close();
    await this.imports.close();
    await this.reports.close();
    await this.connection.quit();
  }
}

export function createProducer(
  opts: { redisEnabled: boolean; redisUrl: string },
  logger: Logger,
): SideEffectProducer {
  return opts.redisEnabled ? new BullProducer(opts.redisUrl) : new NoopProducer(logger);
}
