import { z } from 'zod';
import type { Logger } from 'pino';
import type { NotificationJob } from '@yiji/shared-types';

/**
 * Assignment notifications (`assignment` NotificationType).
 *
 * When an agent assigns a conversation or a ticket to a colleague, that
 * colleague must be told — the Preferences page already exposes an "Assignment"
 * channel toggle and the bell promises assignments land there, but nothing ever
 * enqueued one.
 *
 * SECURITY (why the request body is so small): unlike /jobs/import and
 * /jobs/report this endpoint is callable by ANY agent, not just admins. If it
 * accepted a recipient/title/body from the client it would be an in-app +
 * email spam/phishing primitive ("Reset your password: <link>" delivered from
 * the CRM to any colleague). So the client may only name an entity; the
 * recipient AND the copy are derived server-side from the entity's CURRENT
 * `assigned_agent` as stored in Directus.
 */

/** The only thing a client is allowed to say. */
export const AssignmentNotifyRequest = z.object({
  entityType: z.enum(['conversation', 'ticket']),
  // Bounded, opaque-id charset: keeps a hostile value out of the derived BullMQ
  // jobId (Redis key material — BullMQ also rejects ':' in custom job ids) and
  // out of any log line. Directus UUIDs pass; anything exotic is a 400.
  entityId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'entityId must be an opaque id'),
});
export type AssignmentNotifyRequest = z.infer<typeof AssignmentNotifyRequest>;

export type AssignmentEntityType = AssignmentNotifyRequest['entityType'];

/** The server-fetched entity the notification is derived from. */
export interface AssignmentEntity {
  id: string;
  /** CURRENT assignee as stored in Directus — never taken from the client. */
  assignedAgent: string | null;
  /** Ticket subject / conversation contact name, used for the body copy. */
  label: string | null;
}

export interface AssignmentNotifyDeps {
  /** Reads the entity with the gateway SERVICE token (the caller may already
   *  have lost read access by handing the item to someone else). */
  loadEntity(type: AssignmentEntityType, id: string): Promise<AssignmentEntity | null>;
  /** Enqueue onto the `notifications` queue; null when Redis is disabled. */
  enqueueNotification(job: NotificationJob, jobId: string): Promise<string | null>;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

export type AssignmentNotifyOutcome =
  | { status: 'invalid'; error: string }
  | { status: 'skipped'; reason: 'not-found' | 'unassigned' | 'self-assign' }
  | { status: 'queue-disabled' }
  | { status: 'enqueued'; jobId: string | null; notification: NotificationJob };

/**
 * Deterministic id so double-clicking "Assign" (or a retried request) collapses
 * into ONE queued notification instead of spamming the assignee. Hyphens only —
 * BullMQ rejects ':' in custom job ids.
 */
export function assignmentJobId(
  type: AssignmentEntityType,
  entityId: string,
  assigneeId: string,
): string {
  return `assign-${type}-${entityId}-${assigneeId}`;
}

/** Title/body/link are built HERE, from the fetched entity — never from input. */
export function buildAssignmentNotification(
  type: AssignmentEntityType,
  entity: AssignmentEntity,
  assigneeId: string,
): NotificationJob {
  const label = entity.label?.trim() || null;
  if (type === 'ticket') {
    return {
      recipientId: assigneeId,
      type: 'assignment',
      title: 'New ticket assigned to you',
      body: label
        ? `Ticket "${label}" was assigned to you.`
        : `Ticket ${entity.id} was assigned to you.`,
      link: `/tickets/${entity.id}`,
      payload: { entityType: 'ticket', ticketId: entity.id },
    };
  }
  return {
    recipientId: assigneeId,
    type: 'assignment',
    title: 'New conversation assigned to you',
    body: label
      ? `A conversation with ${label} was assigned to you.`
      : 'A conversation was assigned to you.',
    // Inbox deep-link (pages/Inbox.tsx reads ?conv=<id>).
    link: `/?conv=${entity.id}`,
    payload: { entityType: 'conversation', conversationId: entity.id },
  };
}

/**
 * Handle one assignment-notify request. `callerId` is the VERIFIED Directus user
 * id of the caller (from their access token) — used only to suppress a
 * self-assignment notification, never as a recipient.
 */
export async function notifyAssignment(
  deps: AssignmentNotifyDeps,
  body: unknown,
  callerId: string,
): Promise<AssignmentNotifyOutcome> {
  const parsed = AssignmentNotifyRequest.safeParse(body);
  if (!parsed.success) return { status: 'invalid', error: 'invalid assignment payload' };
  const { entityType, entityId } = parsed.data;

  const entity = await deps.loadEntity(entityType, entityId);
  if (!entity) {
    deps.logger.debug({ entityType, entityId }, 'assignment notify: entity not found');
    return { status: 'skipped', reason: 'not-found' };
  }

  const assignee = entity.assignedAgent?.trim() || null;
  if (!assignee) {
    deps.logger.debug({ entityType, entityId }, 'assignment notify: no assignee');
    return { status: 'skipped', reason: 'unassigned' };
  }
  if (assignee === callerId) {
    deps.logger.debug({ entityType, entityId }, 'assignment notify: self-assign, skipped');
    return { status: 'skipped', reason: 'self-assign' };
  }

  const notification = buildAssignmentNotification(entityType, entity, assignee);
  const jobId = await deps.enqueueNotification(
    notification,
    assignmentJobId(entityType, entity.id, assignee),
  );
  if (jobId === null) return { status: 'queue-disabled' };
  deps.logger.info({ entityType, entityId, jobId }, 'assignment notification enqueued');
  return { status: 'enqueued', jobId, notification };
}
