import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems } from '@directus/sdk';
import {
  QUEUES,
  asCouponPushConnector,
  createEnvConnectorRegistry,
  mockVendorsAllowed,
  isUnknownVendor,
  vendorsFromRows,
  type ConnectorRegistry,
  type VendorRow,
  type QueueName,
  type NotificationJob,
  type SlaJob,
  type AiJob,
  type AutomationJob,
  type ImportJob,
  type ReportJob,
  type RoutingJob,
  type CouponPushJob,
  type CustomerPushJob,
} from '@yiji/shared-types';
import type { MailTransport } from '../mail/index.js';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { processSlaJob, type SlaDeps } from './sla.js';
import { processNotificationJob, type NotifDeps } from './notifications.js';
import { processAiJob, type AiDeps } from './ai.js';
import {
  processAutomationJob,
  runInactivitySweep,
  INACTIVITY_SWEEP_NAME,
  type AutomationDeps,
} from './automation.js';
import { processImportJob, type ImportsDeps } from './imports.js';
import { processReportJob, type ReportsDeps } from './reports.js';
import { processCouponPushJob } from './coupon-push.js';
import { readCouponVendor, resolveCouponConnector } from './coupon-vendor.js';
export { runCouponDeliverySweep } from './coupon-push.js';
import { processCustomerPushJob } from './customer-push.js';
import { handleRouting } from '../routing.js';
import {
  createTicketRepo,
  createConversationRepo,
  createNotificationsRepo,
  createRoutingRepo,
  createTeamRepo,
} from './directus-repos.js';

/**
 * Queue processor registry — every queue (sla, notifications, ai, automation,
 * imports, reports) is backed by a real processor.
 */
export interface ProcessorDeps {
  logger: Logger;
  directus: YijiDirectusClient;
  mail: MailTransport;
  queues: Record<QueueName, Queue>;
  onInAppNotification?: (n: { id: string; recipient: string; type: string }) => void;
  /** AI gateway URL + service token — used by the `ai` processor. */
  ai?: { gatewayUrl: string; gatewayToken: string; workerUserId: string };
  /** Directus URL + service token for the imports processor to download CSVs. */
  imports?: { directusUrl: string; directusToken: string };
  /** Minutes of silence before a conversation is swept as inactive. */
  inactivityMinutes?: number;
}

export type Processor = (job: Job, deps: ProcessorDeps) => Promise<void>;

/**
 * One poster for the process, because it CACHES ITS TOKEN.
 *
 * Rebuilt per job it would sign into Yiji again on every coupon — a login per
 * delivery, and a burst of them the moment a supervisor approves a batch.
 */
/**
 * COUPON DELIVERY IS OFF UNTIL SOMEBODY TURNS IT ON.
 *
 * Every other integration in this service is safe to have running: the worst a
 * misconfigured one does is fail. This one hands real money to real customers,
 * and it works from a BACKLOG — the delivery sweep picks up everything approved
 * and undelivered, so the first tick after it goes live sends all of them at
 * once.
 *
 * That must be a decision somebody makes, not a side effect of restarting a
 * worker on a laptop. The credential cannot be the switch, because it is shared
 * with the order status-history integration that has been live for weeks.
 *
 * Off unless `YIJI_COUPON_DELIVERY` is exactly `on`. Everything else still
 * runs: approvals are recorded, jobs are queued, and each one reports
 * `disabled` and stays `approved` — which is the honest state, and exactly what
 * the console now shows as "waiting to be sent to Yiji".
 */
const couponDeliveryEnabled =
  (process.env.YIJI_COUPON_DELIVERY ?? '').trim().toLowerCase() === 'on';

/**
 * STAGING ONLY: send every coupon to one test handset instead of the customer.
 *
 * Staging shares Yiji's PRODUCTION coupon API — there is no sandbox — so a
 * coupon raised while testing reaches a real stranger and CANNOT be revoked
 * from our side. Redirecting them all to the owner's own number makes staging
 * safe to exercise end to end (owner, 2026-09-22).
 *
 * REFUSED IN PRODUCTION, loudly. A redirect that survived into production
 * would divert real customers' compensation to a test phone and look entirely
 * healthy doing it — every push would report `delivered`. So this throws at
 * startup rather than logging a warning nobody reads: a worker that cannot
 * start is a visible failure, and a silently misdirected coupon is not.
 *
 * NOT keyed on `NODE_ENV`. Both environments run `NODE_ENV=production` —
 * verified on the live task definitions, 2026-09-22 — so that test would have
 * refused to start the STAGING worker, which is the one that needs this. The
 * honest discriminator is the Directus each worker talks to: production's own
 * host is the thing that must never carry a redirect.
 */
function stagingOnlyPhone(varName: string): string | undefined {
  const to = (process.env[varName] ?? '').trim();
  if (!to) return undefined;
  const directus = (process.env.DIRECTUS_INTERNAL_URL ?? '').toLowerCase();
  if (directus.includes('prod-directus') || directus.includes('crm-api.anan.sa')) {
    throw new Error(
      `${varName} is set on a worker pointed at PRODUCTION Directus ` +
        `(${process.env.DIRECTUS_INTERNAL_URL}). That would divert every customer's ` +
        'message to one test handset while reporting success. Unset it.',
    );
  }
  return to;
}

const redirectCouponsTo = stagingOnlyPhone('COUPON_REDIRECT_PHONE');

/**
 * STAGING ONLY: every customer PUSH to one handset.
 *
 * Same reasoning as the coupon redirect and the same guard: staging shares
 * Yiji's production notification service, so testing otherwise rings a real
 * stranger's phone with an agent's words.
 */
const redirectPushTo = stagingOnlyPhone('PUSH_REDIRECT_PHONE');

/**
 * MV-6: serve `mock` (test) vendors. Read at module load, like the redirects,
 * so ALLOW_MOCK_VENDORS against production Directus stops the worker at
 * startup instead of at its first coupon.
 */
const allowMockVendors = mockVendorsAllowed(process.env);

/**
 * THE COMMERCE CONNECTORS (MV-2), built ONCE for the process.
 *
 * Once, because the connector's admin poster CACHES ITS TOKEN: rebuilt per job
 * it would sign into Yiji again on every coupon - a login per delivery, and a
 * burst of them the moment a supervisor approves a batch. The registry keeps
 * one connector per vendor, so that stays true per vendor.
 *
 * Settings are today's env for every Yiji vendor (`YIJI_VENDOR_ID`, default
 * '1', owns the legacy records) - exactly the env the five Yiji
 * readers/posters were built from before, no order-API token, as before.
 * Since MV-1 the VENDORS come from the `vendors` table (read with the
 * workers' own token, cached), because a coupon row names its vendor by CRM
 * UUID; while that read fails the env vendor still answers, with a warning.
 * Built on the first job, which is the first moment a Directus client exists.
 * Inside the connector each capability is still built by its own
 * `createYiji*` factory, so:
 *  - `readCouponOrderContext` reads Yiji's own record of an order for the
 *    coupon payload (a failure is "less corroboration", never a reason not to
 *    deliver);
 *  - `findCustomerIdByPhone` finds the customer for a coupon with NO order,
 *    null without the admin credential (the coupon then stays `approved`);
 *  - `findCustomerCoupon` reads back whether a customer HOLDS a code before a
 *    refusal is recorded (OPS-54R27RS7, 2026-10-07);
 *  - `adminPost` is the one signed-in poster coupon AND push share.
 */
let registry: ConnectorRegistry | null = null;
function connectorsFor(deps: Pick<ProcessorDeps, 'directus' | 'logger'>): ConnectorRegistry {
  registry ??= buildConnectors(deps);
  return registry;
}
const buildConnectors = (deps: Pick<ProcessorDeps, 'directus' | 'logger'>) =>
  createEnvConnectorRegistry({
    vendorId: process.env.YIJI_VENDOR_ID,
    /* MV-6: the test vendor's `mock` platform, only with ALLOW_MOCK_VENDORS=true
       (throws if that flag meets production Directus). */
    allowMockVendors,
    loadVendors: async () =>
      vendorsFromRows(
        (await deps.directus.request(
          readItems(
            'vendors' as never,
            {
              /* `platform` picks the connector (MV-6): without it a mock
                 vendor would read as Yiji. Granted in roles.ts. */
              fields: ['id', 'yiji_vendor_id', 'status', 'name', 'platform'],
              limit: -1,
            } as never,
          ),
        )) as unknown as VendorRow[],
      ),
    onDirectoryFallback: (err) =>
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'vendors read failed - commerce connectors fall back to the env vendor',
      ),
    yiji: {
      client: {
        apiUrl: process.env.YIJI_API_URL ?? '',
        adminApiUrl: process.env.YIJI_ADMIN_API_URL ?? '',
        adminEmail: process.env.YIJI_ADMIN_EMAIL ?? '',
        adminPassword: process.env.YIJI_ADMIN_PASSWORD ?? '',
      },
      tenantId: process.env.YIJI_TENANT_ID,
      brandId: process.env.YIJI_BRAND_ID,
      push: {
        notifyUrl: process.env.YIJI_NOTIFY_URL,
        notifyTopic: process.env.YIJI_NOTIFY_TOPIC,
        notifyTitle: process.env.YIJI_NOTIFY_TITLE,
        openChatAction: process.env.YIJI_OPEN_CHAT_ACTION,
        apiKey: process.env.YIJI_API_KEY,
      },
    },
  });

export const processors: Record<QueueName, Processor> = {
  [QUEUES.sla]: async (job, deps) => {
    const slaDeps: SlaDeps = {
      tickets: createTicketRepo(deps.directus),
      conversations: createConversationRepo(deps.directus),
      teams: createTeamRepo(deps.directus),
      /* Last resort when a breached chat has neither an owner nor a team —
         which, in this deployment, is every unowned chat. Same resolver the
         routing ladder alerts with, so "who is a supervisor" has one answer. */
      supervisorIds: () => createRoutingRepo(deps.directus).supervisorIds!(),
      slaQueue: deps.queues[QUEUES.sla],
      notificationsQueue: deps.queues[QUEUES.notifications],
      logger: deps.logger,
    };
    await processSlaJob(
      job as Job<SlaJob & { deadline?: 'first_response' | 'resolution' }>,
      slaDeps,
    );
  },
  [QUEUES.notifications]: async (job, deps) => {
    const notifDeps: NotifDeps = {
      notifications: createNotificationsRepo(deps.directus),
      mail: deps.mail,
      logger: deps.logger,
      onInAppCreated: deps.onInAppNotification,
    };
    await processNotificationJob(job as Job<NotificationJob>, notifDeps);
  },
  [QUEUES.ai]: async (job, deps) => {
    if (!deps.ai) {
      deps.logger.warn({ jobId: job.id }, 'ai processor invoked without AI deps configured');
      return;
    }
    const aiDeps: AiDeps = {
      directus: deps.directus,
      gatewayUrl: deps.ai.gatewayUrl,
      gatewayToken: deps.ai.gatewayToken,
      workerUserId: deps.ai.workerUserId,
      logger: deps.logger,
    };
    await processAiJob(job as Job<AiJob>, aiDeps);
  },
  [QUEUES.automation]: async (job, deps) => {
    // The recurring inactivity sweep shares the automation queue but isn't a
    // per-entity trigger — it fans out one inactivity job per stale conversation.
    if (job.name === INACTIVITY_SWEEP_NAME) {
      await runInactivitySweep({
        directus: deps.directus,
        automationQueue: deps.queues[QUEUES.automation],
        logger: deps.logger,
        thresholdMinutes: deps.inactivityMinutes ?? 120,
      });
      return;
    }
    const autoDeps: AutomationDeps = {
      directus: deps.directus,
      logger: deps.logger,
      notificationsQueue: deps.queues[QUEUES.notifications],
      automationQueue: deps.queues[QUEUES.automation],
    };
    await processAutomationJob(job as Job<AutomationJob>, autoDeps);
  },
  [QUEUES.imports]: async (job, deps) => {
    if (!deps.imports) {
      deps.logger.warn(
        { jobId: job.id },
        'imports processor invoked without imports deps configured',
      );
      return;
    }
    const importDeps: ImportsDeps = {
      directus: deps.directus,
      directusUrl: deps.imports.directusUrl,
      directusToken: deps.imports.directusToken,
      logger: deps.logger,
    };
    await processImportJob(job as Job<ImportJob>, importDeps);
  },
  [QUEUES.reports]: async (job, deps) => {
    const reportDeps: ReportsDeps = {
      directus: deps.directus,
      mail: deps.mail,
      logger: deps.logger,
    };
    await processReportJob(job as Job<ReportJob>, reportDeps);
  },
  [QUEUES.routing]: async (job, deps) => {
    const routingJob = job.data as RoutingJob;
    await handleRouting(routingJob, {
      // The queue's own Redis connection doubles as the presence reader — the
      // gateway writes the online set to the same instance.
      redis: (deps.queues[QUEUES.routing].opts.connection ?? {}) as never,
      directus: createRoutingRepo(deps.directus),
      schedule: async (next, delayMs) => {
        await deps.queues[QUEUES.routing].add(next.stage, next, {
          delay: delayMs,
          jobId: `route-${next.stage}-${next.conversationId}-${Date.now()}`,
        });
      },
      /*
       * Two notifications, two keyings — and the difference matters.
       *
       * Both go through the existing notifications queue rather than writing a
       * row directly, so they inherit the in-app + email delivery both channels
       * already do.
       *
       * `no_agent` (the supervisor alert) is once per conversation+recipient,
       * so a deterministic job id is exactly right: a ladder that runs twice
       * for the same chat must not alert twice.
       *
       * `assigned` (telling an agent a chat is now theirs) must NOT be keyed
       * that way. BullMQ IGNORES an add whose job id already exists, completed
       * or not, so a deterministic id would deliver the first handover to an
       * agent and silently swallow every later one — including a chat passed
       * back to them an hour later, which would arrive in precisely the
       * silence this notification exists to end. Timestamped instead.
       */
      notify: async ({ recipientId, conversationId, title, body, kind }) => {
        const assigned = kind === 'assigned';
        await deps.queues[QUEUES.notifications].add(
          'send',
          {
            recipientId,
            type: 'escalation',
            title,
            body,
            link: `/inbox/${conversationId}`,
            payload: {
              conversationId,
              reason: assigned ? 'assigned_to_you' : 'no_agent_available',
            },
          },
          {
            jobId: assigned
              ? `route-assigned-${conversationId}-${recipientId}-${Date.now()}`
              : `route-noagent-${conversationId}-${recipientId}`,
          },
        );
      },
      log: (msg, extra) => deps.logger.info(extra ?? {}, msg),
    });
  },
  [QUEUES.coupons]: async (job, deps) => {
    /*
     * The ROW's vendor picks the connector (MV-1) - for the coupon and the
     * signup watch that rides on this job. A row with no vendor is a pre-MV-1
     * row and goes to the legacy Yiji vendor, logged; a vendor with no
     * connector gets nothing and the coupon stays `approved`. See
     * `resolveCouponConnector`.
     */
    const couponApprovalId = (job.data as CouponPushJob).couponApprovalId;
    const connector = await resolveCouponConnector({
      connectors: connectorsFor(deps),
      couponApprovalId,
      vendor: await readCouponVendor(deps.directus, couponApprovalId, deps.logger),
      logger: deps.logger,
    });
    if (!connector) return;
    /* Yiji, or the mock (answers Yiji's shapes in memory, MV-6). */
    const yiji = asCouponPushConnector(connector);
    await processCouponPushJob(job as Job<CouponPushJob>, {
      directus: deps.directus,
      logger: deps.logger,
      /*
       * Signed in as the service account, with the SAME credential the
       * status-history integration already uses against this host — the coupon
       * endpoint lives on the Yiji admin API too.
       *
       * Not a bearer token in an env file. That is a secret with no expiry, no
       * rotation and no owner, copied between machines every time the stack is
       * deployed; this signs in, holds the token in memory, and re-signs when
       * it expires. `null` when the credential is absent, which leaves the
       * request `approved` rather than pretending it was delivered.
       */
      postCoupon: (couponDeliveryEnabled ? yiji.adminPost : null) ?? undefined,
      readOrder: yiji.readCouponOrderContext ?? undefined,
      /* Only consulted for a coupon with NO order, and gated on the same
         delivery switch as the poster: a deployment with coupon delivery off
         must not start resolving customers either. */
      findCustomer: (couponDeliveryEnabled ? yiji.findCustomerIdByPhone : null) ?? undefined,
      findUserCoupon: (couponDeliveryEnabled ? yiji.findCustomerCoupon : null) ?? undefined,
      // Yiji's API is multi-tenant and routes on this header. Defaulted to the
      // tenant the captured request used rather than left blank: a missing
      // tenant is a refusal Yiji reports as a 200, which is the hardest kind
      // of failure to read.
      yijiTenantId: yiji.settings.tenantId ?? '1',
      // Staging only; refused outright in production — see above.
      ...(redirectCouponsTo ? { redirectCouponsTo } : {}),
    });
  },
  [QUEUES.customerPush]: async (job, deps) => {
    /*
     * The CONVERSATION's vendor picks the connector. A job queued before the
     * gateway stamped it (or a conversation with no vendor) is the legacy
     * vendor's. LEGACY: the gateway stamps the vendor on every job since MV-2,
     * so this fallback serves only older jobs and vendor-less conversations -
     * remove it together with `defaultVendorForLegacyRecords`.
     *
     * An unknown vendor is NOT retried and NOT sent through Yiji: retrying
     * cannot make the vendor known, and another vendor's customer must never
     * be pushed through this one's credential.
     */
    const pushJob = job as Job<CustomerPushJob>;
    const connectors = connectorsFor(deps);
    let yiji: ReturnType<typeof asCouponPushConnector>;
    try {
      yiji = asCouponPushConnector(
        await connectors.connectorFor(
          pushJob.data.vendorId ?? (await connectors.defaultVendorForLegacyRecords()),
        ),
      );
    } catch (err) {
      if (!isUnknownVendor(err)) throw err;
      deps.logger.error(
        { jobId: job.id, vendorId: pushJob.data.vendorId, reason: err.reason },
        'customer push for a vendor with no connector - not sent',
      );
      return;
    }
    const push = yiji.settings.push ?? {};
    await processCustomerPushJob(pushJob, {
      logger: deps.logger,
      // Blank disables delivery and logs the payload — the concrete thing to
      // hand the mobile developer when agreeing the contract.
      yijiNotifyUrl: push.notifyUrl ?? '',
      /* The `prop1` action the app matches on to open CRM chat. Defaults to
         the agreed `crm.openchat`; an env var so a change on their side costs
         a config edit, not a release. */
      ...(push.openChatAction?.trim() ? { openChatAction: push.openChatAction.trim() } : {}),
      // Staging only; refused outright against production Directus.
      ...(redirectPushTo ? { redirectPushTo } : {}),
      yijiApiKey: push.apiKey ?? '',
      // Which of Yiji's notification templates means "a support agent replied".
      // Unset until they name it; see the note on CustomerPushDeps.
      yijiNotifyTopic: push.notifyTopic ? Number(push.notifyTopic) : null,
      // Yiji's tenant. 1 for Yiji; configurable so a second platform is a
      // setting rather than an edit.
      yijiTenantId: yiji.settings.tenantId ? Number(yiji.settings.tenantId) : 1,
      // Yiji resolves the Firebase credential from the brand, so it is required.
      yijiBrandId: yiji.settings.brandId ? Number(yiji.settings.brandId) : 1,
      /* The brand of the customer's LATEST ORDER picks the credential; the
         default above is only for a customer with no order history. */
      latestBrandName: yiji.latestOrderBrandName
        ? (_vendorId, externalCustomerId) => yiji.latestOrderBrandName!(externalCustomerId)
        : undefined,
      yijiVendorId: yiji.vendor.platformVendorId,
      // The notification's heading. The agent's words are the body, so this
      // names who is speaking rather than repeating the message.
      yijiNotifyTitle: push.notifyTitle || 'Yiji Support',
      /* Where the tap lands: the CRM chat, opened from inside the Yiji app.
         Falls back to the production chat host so a missing setting does not
         send a notification nobody can act on. */
      crmChatUrl: process.env.CRM_CHAT_URL || 'https://crm.anan.sa',
      /* Signed in as the service, the same way the coupon push is — no pasted
         bearer token to rotate, and nothing goes silent when one lapses. */
      postNotification: yiji.adminPost ?? undefined,
      /*
       * Records "this handset cannot be rung" where an AGENT can see it.
       *
       * Yiji's refusal is a fact about the customer, and the person who needs
       * it is the agent waiting for a reply — so it goes on the conversation,
       * not only into CloudWatch. Cleared on a later success, because the
       * condition is not permanent for the person, only for the attempt.
       */
      markUnreachable: async (conversationId, reason) => {
        await createConversationRepo(deps.directus).patchConversation(conversationId, {
          push_unreachable_at: reason ? new Date().toISOString() : null,
          push_unreachable_reason: reason,
        });
      },
    });
  },
};

export { scheduleReconcile } from './sla.js';
export { scheduleInactivitySweep } from './automation.js';
export { syncScheduledReports } from './reports.js';
