import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUES, type NotificationJob, type Priority, type SlaJob } from '@yiji/shared-types';
import { computeDueAt, warningAt } from '../lib/sla-clock.js';
import type { TicketRepo, TicketRow, SlaPolicyRow, TeamRepo } from './repos.js';

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
  teams: TeamRepo;
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

type SlaNotificationType = 'sla_warning' | 'sla_breach' | 'escalation';

const NOTIFICATION_COPY: Record<SlaNotificationType, { title: string; state: string }> = {
  sla_warning: { title: 'SLA warning on ticket', state: 'is approaching' },
  sla_breach: { title: 'SLA breached on ticket', state: 'has been missed' },
  escalation: { title: 'Ticket escalated after SLA breach', state: 'was missed' },
};

/** Enqueue an in-app + email notification fanout via the notifications queue. */
async function enqueueNotification(
  deps: SlaDeps,
  recipient: string,
  type: SlaNotificationType,
  ticket: TicketRow,
  deadline: Deadline,
  extraPayload: Record<string, unknown> = {},
  /**
   * Escalation copy differs for a teammate. The bell renders this body verbatim,
   * and "the ticket has been escalated" reads as an FYI — which is exactly the
   * diffusion-of-responsibility failure the fanout exists to prevent. A teammate
   * needs to be told the ticket is unowned and that picking it up is the action.
   */
  tail?: string,
): Promise<void> {
  const copy = NOTIFICATION_COPY[type];
  const suffix = tail ?? (type === 'escalation' ? ' The ticket has been escalated.' : '');
  const job: NotificationJob = {
    recipientId: recipient,
    type,
    title: `${copy.title} ${ticket.id}`,
    body: `${deadline === 'first_response' ? 'First-response' : 'Resolution'} ${copy.state} for ticket ${ticket.id}.${suffix}`,
    link: `/tickets/${ticket.id}`,
    payload: { ticketId: ticket.id, deadline, ...extraPayload },
  };
  // Deterministic id per (type, ticket, deadline, RECIPIENT) so a retry / stalled
  // re-run does not enqueue a duplicate SLA notification. The recipient must be
  // part of the key: escalation now fans out to a whole team, and without it
  // BullMQ would collapse every teammate's job into one and only the first
  // person would ever be paged.
  await deps.notificationsQueue.add(type, job, {
    jobId: `slanotif-${type}-${ticket.id}-${deadline}-${recipient}`,
  });
}

/**
 * Who hears about an escalation: the assigned agent AND everyone on the
 * assigned team, deduped and order-stable (agent first).
 *
 * Escalating is precisely the moment the audience should widen — the point is
 * that the owner did NOT act, so paging only the owner re-asks the person who
 * already missed it. This also covers the previously silent case of a breach on
 * an UNASSIGNED ticket that has a team: before, nobody was paged at all.
 *
 * A team read failure must not sink the escalation — the priority bump and the
 * audit event are the load-bearing parts, so we log and fall back to the agent.
 */
async function escalationRecipients(deps: SlaDeps, ticket: TicketRow): Promise<string[]> {
  const recipients = new Set<string>();
  if (ticket.assigned_agent) recipients.add(ticket.assigned_agent);
  if (ticket.assigned_team) {
    try {
      for (const id of await deps.teams.listMemberIds(ticket.assigned_team)) recipients.add(id);
    } catch (err) {
      deps.logger.warn(
        {
          ticketId: ticket.id,
          team: ticket.assigned_team,
          err: err instanceof Error ? err.message : String(err),
        },
        'could not read team members for escalation fanout — notifying the assigned agent only',
      );
    }
  }
  return [...recipients];
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

/**
 * Escalation target. Mirrors the `escalate` automation action
 * (processors/automation.ts): escalating raises priority to the top of the
 * ladder and notifies. Encoded here so both paths mean the same thing.
 */
export const ESCALATED_PRIORITY: Priority = 'urgent';

/**
 * Has this exact (ticket, deadline) breach already been escalated?
 *
 * `ticket_events` is append-only, so it is the one durable record that survives
 * a worker crash — a stalled/retried breach job re-reads it and no-ops. We can't
 * lean on ticket.priority alone: a ticket may already be `urgent` before it
 * breaches, and the two deadlines escalate independently.
 */
async function alreadyEscalated(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
): Promise<boolean> {
  const prior = await deps.tickets.listTicketEvents(ticketId, 'sla_escalated');
  return prior.some((e) => (e.payload as { deadline?: string } | null)?.deadline === deadline);
}

export async function runBreach(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
): Promise<void> {
  const t = await deps.tickets.getTicket(ticketId);
  if (!t || isDone(t)) return;
  if (deadline === 'first_response' && t.first_responded_at) return;

  // Idempotency gate for the WHOLE breach side-effect set (FR-017). Breach jobs
  // are at-least-once; without this a retry appends a duplicate sla_breached
  // event and re-escalates.
  if (await alreadyEscalated(deps, t.id, deadline)) {
    deps.logger.debug({ ticketId: t.id, deadline }, 'sla breach already processed — skipping');
    return;
  }

  await deps.tickets.createTicketEvent(t.id, 'sla_breached', { deadline });

  // ── Escalate (FR-017) ────────────────────────────────────────────────
  const fromPriority = t.priority;
  if (fromPriority !== ESCALATED_PRIORITY) {
    await deps.tickets.patchTicket(t.id, { priority: ESCALATED_PRIORITY });
  }
  await deps.tickets.createTicketEvent(t.id, 'sla_escalated', {
    deadline,
    reason: 'sla_breach',
    from_priority: fromPriority,
    to_priority: ESCALATED_PRIORITY,
    team: t.assigned_team,
  });

  // The plain breach notice stays OWNER-ONLY: it reports that this agent's
  // deadline was missed, and sending that to eight teammates is noise, not
  // signal. Only the escalation widens.
  if (t.assigned_agent) {
    await enqueueNotification(deps, t.assigned_agent, 'sla_breach', t, deadline);
  }

  // Separate escalation notification so it is distinguishable in the inbox
  // (and routable by notification preferences) from the plain breach notice.
  const recipients = await escalationRecipients(deps, t);
  for (const recipient of recipients) {
    const isAssignee = recipient === t.assigned_agent;
    await enqueueNotification(
      deps,
      recipient,
      'escalation',
      t,
      deadline,
      {
        reason: 'sla_breach',
        fromPriority,
        toPriority: ESCALATED_PRIORITY,
        team: t.assigned_team,
        // Lets the portal distinguish "your ticket escalated" from "a ticket on
        // your team escalated" without re-reading the ticket.
        isAssignee,
      },
      isAssignee
        ? ' The ticket has been escalated.'
        : t.assigned_agent
          ? ' It is now urgent and still unanswered on your team — pick it up if the assignee cannot.'
          : ' It is now urgent, unassigned and unanswered on your team — please pick it up.',
    );
  }

  if (recipients.length === 0) {
    // No agent and no team (or an empty team): nobody to page. The sla_escalated
    // event + priority bump still land, so the ticket surfaces at the top of the
    // queue views.
    deps.logger.warn(
      { ticketId: t.id, deadline, team: t.assigned_team },
      'sla breach escalated but no agent or team member to notify',
    );
  }
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
