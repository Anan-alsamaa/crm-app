import { Queue } from 'bullmq';
import { createRedis, bullPrefix } from '@yiji/shared-config/redis';
import type { Redis, Cluster } from 'ioredis';
import type { Logger } from 'pino';
import {
  QUEUES,
  DEFAULT_JOB_OPTIONS,
  type AutomationJob,
  type ImportJob,
  type NotificationJob,
  type ReportJob,
  type RoutingJob,
  type CustomerPushJob,
  CouponPushJob,
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
  /** Agent-triggered: notify the assignee of a conversation/ticket. `jobId` is
   *  deterministic (assign-<type>-<entity>-<assignee>) so repeat calls collapse. */
  enqueueNotification(job: NotificationJob, jobId: string): Promise<string | null>;
  /**
   * Kick off auto-assignment for a conversation nobody owns yet. The jobId is
   * deterministic per conversation so a burst of customer messages starts ONE
   * ladder rather than racing several against each other.
   */
  enqueueRouting(job: RoutingJob): Promise<string | null>;
  /**
   * Admin-triggered: tell Yiji about an approved coupon. The jobId is the
   * approval's own id, so a supervisor double-clicking Approve, or the page
   * retrying, cannot queue the same coupon twice.
   */
  enqueueCouponPush(job: CouponPushJob): Promise<string | null>;
  /**
   * Tell a customer's phone an agent replied while they were away. Enqueued
   * only when no customer socket is in the conversation — somebody watching
   * the chat does not need a notification about the message on their screen.
   */
  enqueueCustomerPush(job: CustomerPushJob): Promise<string | null>;
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
  async enqueueRouting(): Promise<string | null> {
    this.logger.warn('auto-assignment skipped (Redis disabled)');
    return null;
  }
  async enqueueImport(): Promise<string | null> {
    this.logger.warn('enqueue import skipped (Redis disabled)');
    return null;
  }
  async enqueueReport(): Promise<string | null> {
    this.logger.warn('enqueue report skipped (Redis disabled)');
    return null;
  }
  async enqueueNotification(): Promise<string | null> {
    this.logger.warn('enqueue notification skipped (Redis disabled)');
    return null;
  }
  async enqueueCouponPush(): Promise<string | null> {
    this.logger.warn('coupon push skipped (Redis disabled)');
    return null;
  }
  async enqueueCustomerPush(): Promise<string | null> {
    this.logger.warn('customer push skipped (Redis disabled)');
    return null;
  }
  async close(): Promise<void> {}
}

class BullProducer implements SideEffectProducer {
  private readonly automation: Queue;
  private readonly imports: Queue;
  private readonly reports: Queue;
  private readonly notifications: Queue;
  private readonly routing: Queue;
  private readonly coupons: Queue;
  private readonly customerPush: Queue;
  private readonly connection: Redis | Cluster;
  /* On a cluster a queue's keys must hash to ONE shard or BullMQ's Lua
   * scripts fail with CROSSSLOT — hence the hash tag. undefined on
   * standalone, which leaves BullMQ's default keyspace untouched. */
  private readonly prefix: string | undefined;
  constructor(redisUrl: string) {
    // Same auto-reconnect posture as the Socket.IO Redis clients.
    // Cluster-aware — see @yiji/shared-config/redis for why.
    this.connection = createRedis(redisUrl);
    this.prefix = bullPrefix(redisUrl);
    this.connection.on('error', () => {
      /* swallow — retried by retryStrategy; logged once by BullMQ */
    });
    this.automation = new Queue(QUEUES.automation, {
      connection: this.connection,
      prefix: this.prefix,
    });
    // Admin-triggered enqueue (imports/reports) lands on the same queues the
    // workers consume — the job NAME is cosmetic; the queue + data shape match.
    this.imports = new Queue(QUEUES.imports, { connection: this.connection, prefix: this.prefix });
    this.reports = new Queue(QUEUES.reports, { connection: this.connection, prefix: this.prefix });
    // Agent-triggered assignment notifications land on the same `notifications`
    // queue the workers' notifications processor consumes (per-type user
    // preferences + email fanout live there — we do NOT notify from here).
    this.notifications = new Queue(QUEUES.notifications, {
      connection: this.connection,
      prefix: this.prefix,
    });
    this.routing = new Queue(QUEUES.routing, { connection: this.connection, prefix: this.prefix });
    this.coupons = new Queue(QUEUES.coupons, { connection: this.connection, prefix: this.prefix });
    this.customerPush = new Queue(QUEUES.customerPush, {
      connection: this.connection,
      prefix: this.prefix,
    });
  }
  async enqueueImport(job: ImportJob): Promise<string | null> {
    const added = await this.imports.add('import', job, DEFAULT_JOB_OPTIONS);
    return added.id ?? null;
  }
  async enqueueReport(job: ReportJob): Promise<string | null> {
    const added = await this.reports.add('run-now', job, DEFAULT_JOB_OPTIONS);
    return added.id ?? null;
  }
  async enqueueNotification(job: NotificationJob, jobId: string): Promise<string | null> {
    const added = await this.notifications.add(job.type, job, { ...DEFAULT_JOB_OPTIONS, jobId });
    return added.id ?? null;
  }
  async enqueueCouponPush(job: CouponPushJob): Promise<string | null> {
    const added = await this.coupons.add('push', job, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `coupon-push-${job.couponApprovalId}`,
    });
    return added.id ?? null;
  }
  async enqueueCustomerPush(job: CustomerPushJob): Promise<string | null> {
    /*
     * Deduped per MESSAGE, not per conversation: an agent sending three lines
     * in a row while the customer is away is one conversation but three
     * distinct things they have not seen. The job id keys on the send time so
     * a retry of the same send cannot double-notify, while a genuinely new
     * message still gets through.
     */
    const added = await this.customerPush.add('reply', job, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `customer-push-${job.conversationId}-${job.sentAt}`,
    });
    return added.id ?? null;
  }
  async enqueueRouting(job: RoutingJob): Promise<string | null> {
    // Deterministic id per conversation+stage: a burst of customer messages must
    // start ONE ladder, not race several that fight over the same assignee.
    const added = await this.routing.add(job.stage, job, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `route-${job.stage}-${job.conversationId}`,
    });
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
    await this.notifications.close();
    await this.connection.quit();
  }
}

export function createProducer(
  opts: { redisEnabled: boolean; redisUrl: string },
  logger: Logger,
): SideEffectProducer {
  return opts.redisEnabled ? new BullProducer(opts.redisUrl) : new NoopProducer(logger);
}
