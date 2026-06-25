import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUES, type NotificationJob, type SlaJob } from '@yiji/shared-types';
import { computeDueAt, warningAt } from '../lib/sla-clock.js';
import type { TicketRepo, TicketRow, SlaPolicyRow } from './repos.js';

/**
 * SLA processor (T071) — handles three job kinds:
 *   reconcile — periodic sweep: picks an SLA policy by priority, computes
 *     deadlines, schedules warning + breach delayed jobs. Idempotent via
 *     stable jobIds.
 *   warning   — fires at warning_threshold_percent of the way to the deadline.
 *   breach    — fires at the deadline.
 *
 * Side effects are pushed through repos + the BullMQ Queues passed in `deps`
 * so the logic is unit-testable without Directus or Redis.
 */

type Deadline = 'first_response' | 'resolution';

export interface SlaDeps {
  tickets: TicketRepo;
  slaQueue: Queue;
  notificationsQueue: Queue;
  logger: Logger;
}

function pickPolicy(ticket: TicketRow, policies: SlaPolicyRow[]): SlaPolicyRow | null {
  return policies.find((p) => p.active && p.applies_to_priority.includes(ticket.priority)) ?? null;
}

function isDone(t: TicketRow): boolean {
  return t.status === 'resolved' || t.status === 'closed';
}

function jobId(ticketId: string, deadline: Deadline, kind: 'warning' | 'breach'): string {
  // BullMQ (v5.50+) rejects custom job ids containing ':' (its redis key
  // delimiter), so use '-' separators.
  return `${ticketId}-${deadline}-${kind}`;
}

/** Schedule (or update) warning + breach delayed jobs for one deadline. */
async function schedule(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
  start: Date,
  dueAt: Date,
  warningPct: number,
): Promise<void> {
  const warningTs = warningAt(start, dueAt, warningPct);
  const now = Date.now();
  const warnDelay = Math.max(0, warningTs.getTime() - now);
  const breachDelay = Math.max(0, dueAt.getTime() - now);

  const wId = jobId(ticketId, deadline, 'warning');
  const bId = jobId(ticketId, deadline, 'breach');

  await deps.slaQueue.add(
    'warning',
    { ticketId, kind: 'warning', deadline, dueAt: dueAt.toISOString() } as SlaJob & {
      deadline: Deadline;
    },
    { delay: warnDelay, jobId: wId, removeOnComplete: true, removeOnFail: false },
  );
  await deps.slaQueue.add(
    'breach',
    { ticketId, kind: 'breach', deadline, dueAt: dueAt.toISOString() } as SlaJob & {
      deadline: Deadline;
    },
    { delay: breachDelay, jobId: bId, removeOnComplete: true, removeOnFail: false },
  );
}

/** Enqueue an in-app + email notification fanout via the notifications queue. */
async function enqueueNotification(
  deps: SlaDeps,
  recipient: string,
  type: 'sla_warning' | 'sla_breach',
  ticket: TicketRow,
  deadline: Deadline,
): Promise<void> {
  const job: NotificationJob = {
    recipientId: recipient,
    type,
    title:
      type === 'sla_warning'
        ? `SLA warning on ticket ${ticket.id}`
        : `SLA breached on ticket ${ticket.id}`,
    body: `${deadline === 'first_response' ? 'First-response' : 'Resolution'} ${
      type === 'sla_warning' ? 'is approaching' : 'has been missed'
    } for ticket ${ticket.id}.`,
    link: `/tickets/${ticket.id}`,
    payload: { ticketId: ticket.id, deadline },
  };
  await deps.notificationsQueue.add(type, job);
}

// ---------------- reconcile ----------------
export async function runReconcile(deps: SlaDeps): Promise<void> {
  const [tickets, policies] = await Promise.all([
    deps.tickets.listOpenTickets(),
    deps.tickets.listActiveSlaPolicies(),
  ]);
  for (const t of tickets) {
    if (isDone(t)) continue;

    // Attach an SLA policy by priority if missing.
    let policyId = t.sla_policy;
    let policy = policyId ? (policies.find((p) => p.id === policyId) ?? null) : null;
    if (!policy) {
      policy = pickPolicy(t, policies);
      if (!policy) continue;
      policyId = policy.id;
      await deps.tickets.patchTicket(t.id, { sla_policy: policyId });
    }

    const start = t.date_created ? new Date(t.date_created) : new Date();
    // Compute + persist due dates if not already set.
    const patch: Partial<TicketRow> = {};
    if (!t.first_response_due_at) {
      const due = computeDueAt(start, policy.first_response_minutes, policy.business_hours);
      patch.first_response_due_at = due.toISOString();
    }
    if (!t.resolution_due_at) {
      const due = computeDueAt(start, policy.resolution_minutes, policy.business_hours);
      patch.resolution_due_at = due.toISOString();
    }
    if (Object.keys(patch).length > 0) await deps.tickets.patchTicket(t.id, patch);

    // Schedule warning + breach for each deadline (idempotent via jobId).
    const frDue = new Date(patch.first_response_due_at ?? t.first_response_due_at!);
    const resDue = new Date(patch.resolution_due_at ?? t.resolution_due_at!);
    if (!t.first_responded_at) {
      await schedule(deps, t.id, 'first_response', start, frDue, policy.warning_threshold_percent);
    }
    await schedule(deps, t.id, 'resolution', start, resDue, policy.warning_threshold_percent);
  }
}

// ---------------- warning / breach ----------------
export async function runWarning(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
): Promise<void> {
  const t = await deps.tickets.getTicket(ticketId);
  if (!t || isDone(t)) return;
  if (deadline === 'first_response' && t.first_responded_at) return;

  // Idempotent: rely on the eventCreated dedup via type+payload at the data
  // layer (multiple warnings allowed in principle; in practice the jobId on
  // the scheduled job makes re-firing rare).
  await deps.tickets.createTicketEvent(t.id, 'sla_warning', { deadline });
  const recipient = t.assigned_agent;
  if (recipient) await enqueueNotification(deps, recipient, 'sla_warning', t, deadline);
}

export async function runBreach(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
): Promise<void> {
  const t = await deps.tickets.getTicket(ticketId);
  if (!t || isDone(t)) return;
  if (deadline === 'first_response' && t.first_responded_at) return;

  await deps.tickets.createTicketEvent(t.id, 'sla_breached', { deadline });
  const recipient = t.assigned_agent;
  if (recipient) await enqueueNotification(deps, recipient, 'sla_breach', t, deadline);
}

// ---------------- main entry ----------------
export async function processSlaJob(
  job: Job<SlaJob & { deadline?: Deadline }>,
  deps: SlaDeps,
): Promise<void> {
  const { kind } = job.data;
  if (kind === 'reconcile') return runReconcile(deps);
  const deadline = (job.data.deadline ?? 'first_response') as Deadline;
  if (kind === 'warning') return runWarning(deps, job.data.ticketId, deadline);
  if (kind === 'breach') return runBreach(deps, job.data.ticketId, deadline);
  deps.logger.warn({ kind }, 'unknown sla job kind');
}

/** Helper used by workers/index.ts at startup to schedule the recurring sweep. */
export async function scheduleReconcile(slaQueue: Queue, everyMs: number): Promise<void> {
  await slaQueue.add('reconcile', { ticketId: '', kind: 'reconcile' } as SlaJob, {
    repeat: { every: everyMs },
    jobId: 'sla-reconcile',
  });
}

// Re-export queue name for index wiring.
export const SLA_QUEUE = QUEUES.sla;
