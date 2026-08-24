import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  pickSlaPolicy,
  QUEUES,
  type NotificationJob,
  type Priority,
  type SlaJob,
} from '@yiji/shared-types';
import { computeDueAt, warningAt, type BusinessHours } from '../lib/sla-clock.js';
import type {
  ConversationRepo,
  ConversationRow,
  SlaPolicyRow,
  TeamRepo,
  TicketRepo,
  TicketRow,
} from './repos.js';

/**
 * SLA processor (T071) — handles three job kinds:
 *   reconcile — periodic sweep: picks the SLA policy whose coverage best fits
 *     the ticket, computes deadlines against the policy's working hours, and
 *     schedules warning + breach delayed jobs. Idempotent via stable jobIds.
 *   warning   — fires at warning_threshold_percent of the way to the deadline.
 *   breach    — fires at the deadline.
 *
 * Side effects are pushed through repos + the BullMQ Queues passed in `deps`
 * so the logic is unit-testable without Directus or Redis.
 */

type Deadline = 'first_response' | 'resolution';

export interface SlaDeps {
  tickets: TicketRepo;
  /**
   * Optional so the ticket tests, and any deployment that has not yet applied
   * the conversation columns, keep working: the chat sweep skips itself rather
   * than taking the whole reconcile down with it.
   */
  conversations?: ConversationRepo;
  teams: TeamRepo;
  slaQueue: Queue;
  notificationsQueue: Queue;
  logger: Logger;
}

/**
 * The policy that governs this ticket, or none.
 *
 * The rule itself lives in @yiji/shared-types so the admin console can show an
 * operator the same answer this sweep will reach — a matching rule that exists
 * in two places is one that will eventually disagree with itself, and the
 * disagreement would surface as a ticket held to a promise nobody could find.
 *
 * Two things it settles that the old one-line `find` did not:
 *
 *   - A policy now narrows by ticket type, arrival channel and brand as well
 *     as priority, so several policies routinely match one ticket. The most
 *     SPECIFIC one wins, rather than whichever row Directus returned first.
 *   - `applies_to_priority` is NULLABLE and often null: the compensation clone
 *     ships five active policies carrying no coverage at all. Dereferencing it
 *     unguarded threw inside `Array.find`, which does not skip to the next
 *     candidate — it propagates, so the whole sweep died before reaching the
 *     policy that DID match. The visible symptom was the entire SLA feature
 *     reporting nothing, forever, while the sweep looked healthy. A policy
 *     that names no coverage governs nothing, which is the honest reading of
 *     an empty list and now the coded one.
 */
function pickPolicy(ticket: TicketRow, policies: SlaPolicyRow[]): SlaPolicyRow | null {
  return pickSlaPolicy(
    policies.filter((p) => p.active),
    {
      priority: ticket.priority,
      complaintType: ticket.complaint_type,
      complaintSource: ticket.complaint_source,
      brandName: ticket.store_snapshot?.brandName ?? null,
    },
    'ticket',
  );
}

/**
 * The policy that governs a CHAT's first response, or none.
 *
 * A chat is matched on priority alone. It has no complaint type, no arrival
 * channel recorded against it and no branch — those are facts a ticket acquires
 * when an agent classifies the complaint, and the promise to answer is over
 * well before that happens. Passing them as nulls is not a shortcut: a policy
 * that DID narrow by brand would then correctly cover no chats at all, which is
 * the honest answer rather than a promise made on a blank.
 */
function pickChatPolicy(c: ConversationRow, policies: SlaPolicyRow[]): SlaPolicyRow | null {
  return pickSlaPolicy(
    policies.filter((p) => p.active),
    { priority: c.priority ?? null },
    'chat',
  );
}

function isDone(t: TicketRow): boolean {
  return t.status === 'resolved' || t.status === 'closed';
}

function jobId(ticketId: string, deadline: Deadline, kind: 'warning' | 'breach'): string {
  // BullMQ (v5.50+) rejects custom job ids containing ':' (its redis key
  // delimiter), so use '-' separators.
  return `${ticketId}-${deadline}-${kind}`;
}

/**
 * When to warn, measured the same way the deadline was.
 *
 * `warningAt` interpolates on the wall clock, which is right for a round-the-
 * clock policy and wrong for one with working hours: 80% of the way through a
 * Thursday-to-Sunday span lands somewhere on Saturday, with the branch shut and
 * nobody to warn. Under working hours the warning is 80% of the WORKED minutes,
 * so it arrives while there is still someone who can act on it.
 *
 * Falls back to the wall clock if the hours are unusable — a warning that fires
 * early is a nuisance, a sweep that dies is the whole feature going quiet.
 */
function warningInstant(
  start: Date,
  dueAt: Date,
  pct: number,
  minutes: number,
  hours: BusinessHours | null,
): Date {
  if (!hours) return warningAt(start, dueAt, pct);
  try {
    return computeDueAt(start, Math.max(1, Math.round((minutes * pct) / 100)), hours);
  } catch {
    return warningAt(start, dueAt, pct);
  }
}

/** Schedule (or update) warning + breach delayed jobs for one deadline. */
async function schedule(
  deps: SlaDeps,
  ticketId: string,
  deadline: Deadline,
  dueAt: Date,
  warningTs: Date,
): Promise<void> {
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
 * Enqueue that cannot abort its caller.
 *
 * `runBreach` writes the `sla_escalated` event BEFORE it notifies, and that
 * event is the idempotency ledger — so if an enqueue throws partway through the
 * fanout, the retried job sees "already escalated" and returns without paging
 * the recipients it never reached. One transient Redis error would silently cost
 * the rest of the team their notification, and the exposure grows with team
 * size. Isolating each recipient turns that into one missed page, logged. The
 * deterministic jobId makes the re-enqueue of an already-queued recipient a
 * no-op, so this is safe rather than duplicative.
 */
async function enqueueIsolated(
  deps: SlaDeps,
  recipient: string,
  type: SlaNotificationType,
  ticket: TicketRow,
  deadline: Deadline,
  extraPayload: Record<string, unknown> = {},
  tail?: string,
): Promise<void> {
  try {
    await enqueueNotification(deps, recipient, type, ticket, deadline, extraPayload, tail);
  } catch (err) {
    deps.logger.error(
      {
        ticketId: ticket.id,
        deadline,
        recipient,
        type,
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to enqueue an SLA notification — continuing with the remaining recipients',
    );
  }
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

    // Attach the best-fitting SLA policy if the ticket has none.
    let policyId = t.sla_policy;
    let policy = policyId ? (policies.find((p) => p.id === policyId) ?? null) : null;
    if (!policy) {
      policy = pickPolicy(t, policies);
      if (!policy) continue;
      policyId = policy.id;
      await deps.tickets.patchTicket(t.id, { sla_policy: policyId });
    }

    const start = t.date_created ? new Date(t.date_created) : new Date();
    /* Compute + persist due dates if not already set.
     *
     * `computeDueAt` THROWS on working hours it cannot satisfy — a policy whose
     * open windows were all cleared, or a target that does not fit inside a
     * year of them. Unguarded, one such policy would abort the sweep for every
     * ticket behind it in the list, which is precisely how this feature went
     * silent for its whole life the last time (see pickPolicy). One broken
     * policy should cost its own tickets and nothing else. */
    const patch: Partial<TicketRow> = {};
    try {
      /*
       * NO FIRST-RESPONSE DEADLINE ON A TICKET.
       *
       * Nothing in this product ever writes `tickets.first_responded_at` —
       * every reference to it is a read. So the clock started and nothing
       * could stop it, and every ticket carrying the deadline breached it and
       * stayed breached. Measured on live data: six tickets with a
       * first-response deadline, one first reply ever recorded, six
       * first_response breach events. An SLA nothing can satisfy is not a
       * target, it is a permanent alarm — and it drowns the resolution breach
       * beside it, which is real.
       *
       * It is also the wrong OBJECT. A ticket is raised out of a conversation
       * that an agent has already answered, so a "first response" measured
       * from the ticket's creation re-judges a reply made before the ticket
       * existed. First response belongs to the CHAT; the ticket's promise is
       * how long it takes to SOLVE. The SLA report reached the same conclusion
       * and dropped the first-response column some time ago — this is the
       * engine catching up with it.
       */
      if (!t.resolution_due_at) {
        const due = computeDueAt(start, policy.resolution_minutes, policy.business_hours);
        patch.resolution_due_at = due.toISOString();
      }
    } catch (err) {
      deps.logger.error(
        {
          ticketId: t.id,
          policy: policy.id,
          policyName: policy.name,
          err: err instanceof Error ? err.message : String(err),
        },
        'could not compute SLA deadlines for this ticket — check the policy working hours',
      );
      continue;
    }
    if (Object.keys(patch).length > 0) await deps.tickets.patchTicket(t.id, patch);

    // Schedule warning + breach for the resolution deadline (idempotent via
    // jobId). Only resolution: see above for why a ticket has no first-response
    // clock.
    const resDue = new Date(patch.resolution_due_at ?? t.resolution_due_at!);
    const pct = policy.warning_threshold_percent;
    const hours = policy.business_hours;
    const resWarn = warningInstant(start, resDue, pct, policy.resolution_minutes, hours);
    await schedule(deps, t.id, 'resolution', resDue, resWarn);
  }
}

// ---------------- chat first response ----------------

/**
 * THE CHAT FIRST-RESPONSE SWEEP.
 *
 * Runs on the same reconcile tick as the ticket sweep, over the chats that are
 * open and still unanswered — the only ones with a live clock. Two things
 * happen per chat, both idempotent:
 *
 *   1. If it has no deadline yet, one is computed from the governing chat
 *      policy and written. Written ONCE and never recomputed: editing a policy
 *      changes what future chats are promised, not what was promised to a
 *      customer already waiting.
 *   2. If the deadline has passed, the breach is recorded and the agent paged.
 *
 * WHY THIS IS NOT SCHEDULED THE WAY TICKETS ARE. A ticket's deadline gets a
 * pair of delayed BullMQ jobs because a resolution promise runs for hours and
 * the warning has to arrive partway through. A chat first-response promise is
 * minutes long, so the warning would land a minute before the breach — two
 * pages, one minute apart, about the same unanswered chat. There is one signal
 * worth sending and the sweep is frequent enough to send it.
 *
 * `first_response_breached_at` is the ledger. Without a written record the
 * sweep would re-page every few minutes for as long as the chat sat unanswered,
 * which is exactly the alert fatigue that made the old ticket first-response
 * breaches worthless.
 */
export async function runChatReconcile(deps: SlaDeps): Promise<void> {
  const repo = deps.conversations;
  if (!repo) return;

  let chats: ConversationRow[];
  let policies: SlaPolicyRow[];
  try {
    [chats, policies] = await Promise.all([
      repo.listUnansweredConversations(),
      deps.tickets.listActiveSlaPolicies(),
    ]);
  } catch (err) {
    // The ticket sweep has already run by this point and must keep its result.
    deps.logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'could not read chats for the first-response sweep — tickets were unaffected',
    );
    return;
  }

  const now = Date.now();
  for (const c of chats) {
    // Defensive: the repo filters on this, but a chat answered between the read
    // and this line must not be judged.
    if (c.first_responded_at) continue;

    let dueAt = c.first_response_due_at;
    if (!dueAt) {
      const policy = pickChatPolicy(c, policies);
      if (!policy) continue;
      const start = c.date_created ? new Date(c.date_created) : new Date();
      /*
       * A PROMISE CANNOT BE MADE RETROACTIVELY.
       *
       * The moment a chat policy is created, every conversation already sitting
       * unanswered in the database becomes overdue against it — 123 of them
       * here, none of which anyone could have known about when they arrived.
       * Judging those would page the whole team at once and open the chat SLA
       * report on a wall of breaches that describe seeding, not service.
       *
       * So the policy governs chats that started AFTER it did. This is not a
       * migration convenience that can be deleted later: it is true every time
       * somebody writes a new policy, and doing it here rather than in a
       * one-off backfill means the next one behaves correctly too.
       */
      if (policy.date_created && start.getTime() < new Date(policy.date_created).getTime()) {
        continue;
      }
      try {
        dueAt = computeDueAt(
          start,
          policy.first_response_minutes,
          policy.business_hours,
        ).toISOString();
      } catch (err) {
        // One unusable policy costs its own chats and nothing else — the same
        // containment the ticket sweep needed after a policy with no open
        // windows once killed the whole run.
        deps.logger.error(
          {
            conversationId: c.id,
            policy: policy.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'could not compute a chat first-response deadline — check the policy working hours',
        );
        continue;
      }
      await repo.patchConversation(c.id, { first_response_due_at: dueAt });
    }

    if (c.first_response_breached_at) continue;
    if (new Date(dueAt).getTime() > now) continue;

    // Ledger first, then notify: a crash between the two costs one page, while
    // the reverse would re-page on every sweep forever.
    await repo.patchConversation(c.id, {
      first_response_breached_at: new Date().toISOString(),
    });

    const recipients = new Set<string>();
    if (c.assigned_agent) recipients.add(c.assigned_agent);
    if (recipients.size === 0 && c.assigned_team) {
      /*
       * An UNASSIGNED chat is the case that matters most — nobody has picked it
       * up, which is usually why it went unanswered — so the team is told. When
       * there IS an owner the team is not copied: that would page eight people
       * about one agent's late reply, and the noise is what stops anyone reading
       * these at all.
       */
      try {
        for (const id of await deps.teams.listMemberIds(c.assigned_team)) recipients.add(id);
      } catch (err) {
        deps.logger.warn(
          { conversationId: c.id, err: err instanceof Error ? err.message : String(err) },
          'could not read team members for an unanswered chat',
        );
      }
    }

    for (const recipient of recipients) {
      const job: NotificationJob = {
        recipientId: recipient,
        type: 'sla_breach',
        title: 'Chat still unanswered',
        body: c.assigned_agent
          ? 'A customer has been waiting past the first-response target. Reply now.'
          : 'A customer has been waiting past the first-response target and the chat is unassigned — please pick it up.',
        link: `/inbox/${c.id}`,
        payload: { conversationId: c.id, deadline: 'first_response', object: 'chat' },
      };
      try {
        await deps.notificationsQueue.add('sla_breach', job, {
          // Once per (chat, recipient), so a retried sweep cannot double-page.
          jobId: `chatsla-${c.id}-${recipient}`,
        });
      } catch (err) {
        deps.logger.error(
          {
            conversationId: c.id,
            recipient,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to enqueue a chat first-response notification',
        );
      }
    }

    if (recipients.size === 0) {
      deps.logger.warn(
        { conversationId: c.id },
        'chat first-response target missed but there is nobody to notify',
      );
    }
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
    await enqueueIsolated(deps, t.assigned_agent, 'sla_breach', t, deadline);
  }

  // Separate escalation notification so it is distinguishable in the inbox
  // (and routable by notification preferences) from the plain breach notice.
  const recipients = await escalationRecipients(deps, t);
  for (const recipient of recipients) {
    const isAssignee = recipient === t.assigned_agent;
    await enqueueIsolated(
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
  if (kind === 'reconcile') {
    await runReconcile(deps);
    // Both promises this business makes are swept on one tick. The chat sweep
    // guards its own reads, so a conversations failure cannot undo the ticket
    // work that has already landed.
    await runChatReconcile(deps);
    return;
  }
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
