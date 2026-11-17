import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { createItem, readItems, readUsers, updateItem } from '@directus/sdk';
import {
  COMPENSATION_CASES_COLLECTION,
  COMPENSATION_ESCALATION_FALLBACK_ROLES,
  COMPENSATION_ESCALATION_SETTING_KEY,
  YIJI_COMPLAINT_SOURCE,
  caseFieldsFromDecided,
  caseFieldsFromEscalated,
  caseFieldsFromWire,
  compensationCaseTicketKey,
  escalationRolesFor,
  formatCaseMoney,
  formatPercentBps,
  mergeCaseStatus,
  parseCompensationEscalationRoles,
  ticketCompensationForCase,
  type CompensationCasePatch,
  type CompensationCaseRow,
  type NotificationJob,
  type Yiji2CompensationEventJob,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';

/**
 * YIJI V2 COMPENSATION EVENTS (owner, 18 Nov 2026; contract
 * `auto-compensation-contract.md` of 2026-11-17). Yiji v2 ONLY: v1 sends no
 * such events and nothing here reads or writes a v1 row.
 *
 *   - `compensation.proposed`: the case is created or updated on its row
 *     (`compensation_cases`, keyed by `case_id`) and gets ONE CRM ticket
 *     (design choice 1, to confirm with the owner). Agents see it through
 *     that ticket (design choice 3: no V2 list route).
 *   - `compensation.decided`: the decision, who made it, the calculated and
 *     issued amounts, the wallet entry / coupon / grant ids, or the failure.
 *     The ticket's Compensation follows (approved -> Compensated; rejected,
 *     expired, failed -> Not Compensated).
 *   - `compensation.escalated`: the row records it, and every active user of
 *     the CRM roles the Administrator mapped to V2's `escalate_to` is told
 *     (design choice 2, to confirm). Roles by NAME (the recipients trap);
 *     nobody reachable -> the Administrator; still nobody -> an error log.
 *
 * Idempotent: the row is found by `case_id`, the ticket by its external id,
 * notification job ids carry the case and the user. An older event arriving
 * after a newer one never moves the case back (`last_event_at`,
 * `mergeCaseStatus`). The job never calls V2.
 */
export type Yiji2CompensationEventOutcome =
  | 'case-created'
  | 'case-updated'
  | 'escalation-sent'
  | 'escalation-no-recipient'
  | 'no-vendor'
  | 'waiting-for-gateway';

export interface Yiji2CompensationEventDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  notificationsQueue?: Pick<Queue, 'add'>;
  /** The CRM vendor (UUID) of `yiji2:<platform id>`; null = no such v2 vendor. */
  vendorOf(vendorKey: string): Promise<{ id: string } | null>;
  /**
   * True while an agent-logged case may still be on its way from the gateway
   * (it records the case on the agent's own ticket from V2's answer). The
   * job then waits (throws, BullMQ retries) instead of opening a second
   * ticket. Absent = never wait.
   */
  mayWaitForGateway?: boolean;
  now?: () => number;
}

type Row = Partial<CompensationCaseRow> & { id: string };

const ROW_FIELDS = ['id', 'case_id', 'ticket', 'status', 'last_event_at', 'vendor'];

async function findCase(deps: Yiji2CompensationEventDeps, caseId: string): Promise<Row | null> {
  const rows = (await deps.directus.request(
    readItems(
      COMPENSATION_CASES_COLLECTION as never,
      { filter: { case_id: { _eq: caseId } }, fields: ROW_FIELDS, limit: 1 } as never,
    ),
  )) as unknown as Row[];
  return rows?.[0] ?? null;
}

/** The ticket the CRM opened for a case before (a retried job, or a lost answer). */
async function findCaseTicket(
  deps: Yiji2CompensationEventDeps,
  vendor: string,
  caseId: string,
): Promise<string | null> {
  const rows = (await deps.directus.request(
    readItems(
      'tickets' as never,
      {
        filter: {
          vendor: { _eq: vendor },
          external_id: { _eq: compensationCaseTicketKey(caseId) },
        },
        fields: ['id'],
        limit: 1,
      } as never,
    ),
  )) as unknown as Array<{ id: string }>;
  return rows?.[0]?.id ?? null;
}

/** The CRM contact of a V2 customer id, under the v2 vendor only. */
async function findContact(
  deps: Yiji2CompensationEventDeps,
  vendor: string,
  customerId: string | null | undefined,
): Promise<{ id: string; phone: string | null } | null> {
  if (!customerId) return null;
  try {
    const rows = (await deps.directus.request(
      readItems(
        'contacts' as never,
        {
          filter: { vendor: { _eq: vendor }, external_customer_id: { _eq: customerId } },
          fields: ['id', 'phone'],
          limit: 1,
        } as never,
      ),
    )) as unknown as Array<{ id: string; phone?: string | null }>;
    const c = rows?.[0];
    return c ? { id: c.id, phone: c.phone ?? null } : null;
  } catch (err) {
    deps.logger.warn(
      { err: describeError(err), customerId },
      'yiji2 compensation: contact lookup failed - the ticket is opened without one',
    );
    return null;
  }
}

function amountText(p: CompensationCasePatch): string {
  if (p.amount_minor != null)
    return formatCaseMoney(p.amount_minor, p.currency ?? p.order_currency);
  if (p.percent_bps != null) return formatPercentBps(p.percent_bps);
  return '—';
}

/** The ticket's subject and description, in the CRM's words (English, stored). */
export function caseTicketText(
  caseId: string,
  p: CompensationCasePatch,
): { subject: string; description: string } {
  const rule = p.row_key ?? p.rule_code ?? 'case';
  const subject = `V2 compensation ${rule} - order ${p.order_number ?? '?'}`.slice(0, 250);
  const lines = [
    `Yiji V2 compensation case #${caseId}. Approve or reject it from this ticket (72 hours).`,
    `Rule: ${rule}${p.occurrence ? ` (occurrence ${p.occurrence})` : ''}`,
    `Action: ${p.action_type ?? '—'}${p.comp_method ? ` / ${p.comp_method}` : ''}`,
    `Amount: ${amountText(p)}`,
  ];
  if (p.complaint_text) lines.push(`Customer said: ${p.complaint_text}`);
  return { subject, description: lines.join('\n') };
}

async function openTicket(
  deps: Yiji2CompensationEventDeps,
  vendor: string,
  caseId: string,
  p: CompensationCasePatch,
  at: string,
): Promise<string> {
  const existing = await findCaseTicket(deps, vendor, caseId);
  if (existing) return existing;
  const contact = await findContact(deps, vendor, p.customer_id);
  const text = caseTicketText(caseId, p);
  const row = {
    vendor,
    external_id: compensationCaseTicketKey(caseId),
    subject: text.subject,
    description: text.description,
    status: 'pending',
    priority: p.escalate_to ? 'high' : 'medium',
    order_id: p.order_number ?? null,
    ...(contact ? { contact: contact.id } : {}),
    ...(contact?.phone ? { customer_phone: contact.phone } : {}),
    complaint_date: at,
    complaint_source: YIJI_COMPLAINT_SOURCE,
    /* Not decided yet: every case needs an agent's approval. */
    compensation: 'Initial',
  };
  try {
    const created = (await deps.directus.request(
      createItem('tickets' as never, row as never, { fields: ['id'] } as never),
    )) as unknown as { id: string };
    deps.logger.info(
      { caseId, ticketId: created.id, order: p.order_number },
      'yiji2 compensation: ticket opened for the case',
    );
    return created.id;
  } catch (err) {
    /* A racing job won (uq_tickets_vendor_external_id): use its ticket. */
    const raced = await findCaseTicket(deps, vendor, caseId).catch(() => null);
    if (raced) return raced;
    throw err;
  }
}

/** Only the columns this event may change (status by the merge rule). */
function rowPatch(
  stored: Row | null,
  incoming: CompensationCasePatch,
  at: string,
): CompensationCasePatch {
  const out: CompensationCasePatch = { ...incoming };
  delete out.case_id;
  const storedAt = stored?.last_event_at ? Date.parse(stored.last_event_at) : NaN;
  const older = !Number.isNaN(storedAt) && storedAt > Date.parse(at);
  if ('status' in incoming) {
    const merged = mergeCaseStatus(stored?.status, incoming.status);
    /* An older open status never replaces a newer one (held -> proposed). */
    if (older && merged === incoming.status && stored?.status) out.status = stored.status;
    else out.status = merged;
  }
  out.last_event_at = older ? stored!.last_event_at! : new Date(at).toISOString();
  return out;
}

export async function processYiji2CompensationEvent(
  job: Yiji2CompensationEventJob,
  deps: Yiji2CompensationEventDeps,
): Promise<Yiji2CompensationEventOutcome> {
  const { directus, logger } = deps;
  const log = { eventId: job.eventId, type: job.type };
  const vendor = await deps.vendorOf(job.vendorKey);
  if (!vendor) {
    logger.error(
      { ...log, vendorKey: job.vendorKey },
      'yiji2 compensation event: no Yiji v2 vendor row for this key - not recorded',
    );
    return 'no-vendor';
  }
  const data = job.data as Record<string, unknown>;
  const incoming =
    job.type === 'compensation.proposed'
      ? caseFieldsFromWire(data)
      : job.type === 'compensation.decided'
        ? caseFieldsFromDecided(data)
        : caseFieldsFromEscalated(data);
  const caseId = incoming.case_id!;
  const stored = await findCase(deps, caseId);

  if (
    !stored &&
    job.type === 'compensation.proposed' &&
    incoming.logged_by_agent &&
    deps.mayWaitForGateway
  ) {
    /* An agent logged this from a ticket: the gateway records the case on
       THAT ticket from V2's answer. Wait for it rather than open a second. */
    logger.info(
      { ...log, caseId },
      'yiji2 compensation: agent-logged case - waiting for the gateway',
    );
    throw new Error('agent-logged compensation case not recorded by the gateway yet');
  }

  const patch = rowPatch(stored, incoming, job.at);
  let ticketId = stored?.ticket ?? null;
  if (!ticketId) ticketId = await openTicket(deps, vendor.id, caseId, incoming, job.at);

  let outcome: Yiji2CompensationEventOutcome;
  if (stored) {
    await directus.request(
      updateItem(COMPENSATION_CASES_COLLECTION as never, stored.id, {
        ...patch,
        ...(stored.ticket ? {} : { ticket: ticketId }),
      } as never),
    );
    outcome = 'case-updated';
  } else {
    try {
      await directus.request(
        createItem(
          COMPENSATION_CASES_COLLECTION as never,
          {
            ...patch,
            case_id: caseId,
            vendor: vendor.id,
            ticket: ticketId,
          } as never,
        ),
      );
      outcome = 'case-created';
    } catch (err) {
      /* The unique case_id: a racing writer (the gateway or a parallel job)
         created it first. Apply this event to that row instead. */
      const raced = await findCase(deps, caseId).catch(() => null);
      if (!raced) throw err;
      await directus.request(
        updateItem(
          COMPENSATION_CASES_COLLECTION as never,
          raced.id,
          rowPatch(raced, incoming, job.at) as never,
        ),
      );
      ticketId = raced.ticket ?? ticketId;
      outcome = 'case-updated';
    }
  }

  /* The ticket's Compensation follows the decision; nothing else about it. */
  const comp = job.type === 'compensation.decided' ? ticketCompensationForCase(patch.status) : null;
  if (comp && ticketId) {
    try {
      await directus.request(
        updateItem('tickets' as never, ticketId, { compensation: comp } as never),
      );
    } catch (err) {
      logger.warn(
        { ...log, caseId, ticketId, err: describeError(err) },
        'yiji2 compensation: ticket Compensation not updated (the case row is)',
      );
    }
  }
  logger.info(
    { ...log, caseId, ticketId, status: patch.status, outcome },
    'yiji2 compensation event',
  );

  if (job.type === 'compensation.escalated' && ticketId)
    return notifyEscalation(job, deps, caseId, ticketId, incoming);
  return outcome;
}

/** The Administrator's mapping, or the defaults when it cannot be read. */
async function escalationMapping(deps: Yiji2CompensationEventDeps) {
  try {
    const rows = (await deps.directus.request(
      readItems(
        'app_settings' as never,
        {
          filter: { key: { _eq: COMPENSATION_ESCALATION_SETTING_KEY } },
          fields: ['value'],
          limit: 1,
        } as never,
      ),
    )) as unknown as Array<{ value?: unknown }>;
    return parseCompensationEscalationRoles(rows?.[0]?.value ?? null);
  } catch (err) {
    deps.logger.warn(
      { err: describeError(err) },
      'yiji2 compensation: escalation setting unreadable - the default manager roles are told',
    );
    return parseCompensationEscalationRoles(null);
  }
}

async function activeUsersIn(
  deps: Yiji2CompensationEventDeps,
  roleNames: readonly string[],
): Promise<string[]> {
  if (!roleNames.length) return [];
  const users = (await deps.directus.request(
    readUsers({
      filter: { status: { _eq: 'active' }, role: { name: { _in: [...roleNames] } } },
      fields: ['id'],
      limit: -1,
    } as never) as never,
  )) as unknown as Array<{ id: string }>;
  return (users ?? []).map((u) => u.id);
}

async function notifyEscalation(
  job: Extract<Yiji2CompensationEventJob, { type: 'compensation.escalated' }>,
  deps: Yiji2CompensationEventDeps,
  caseId: string,
  ticketId: string,
  p: CompensationCasePatch,
): Promise<Yiji2CompensationEventOutcome> {
  const { logger } = deps;
  if (!deps.notificationsQueue) {
    logger.error({ caseId }, 'yiji2 compensation escalated: no notifications queue - nobody told');
    return 'escalation-no-recipient';
  }
  const mapping = await escalationMapping(deps);
  const roles = escalationRolesFor(mapping, p.escalate_to);
  /* Read failures throw: BullMQ retries, and the job ids keep it to one each. */
  let recipients = await activeUsersIn(deps, roles);
  if (!recipients.length) {
    logger.warn(
      { caseId, escalateTo: p.escalate_to, roles },
      'yiji2 compensation escalated: the mapped roles have no active user - telling the Administrator',
    );
    recipients = await activeUsersIn(deps, COMPENSATION_ESCALATION_FALLBACK_ROLES);
  }
  if (!recipients.length) {
    logger.error(
      { caseId, escalateTo: p.escalate_to, roles },
      'yiji2 compensation escalated: NOBODY to tell - no active user in the mapped roles or Administrator',
    );
    return 'escalation-no-recipient';
  }
  const total =
    p.order_total_minor != null ? formatCaseMoney(p.order_total_minor, p.order_currency) : null;
  const title = `V2 compensation escalated to ${p.escalate_to ?? 'management'}: ${p.row_key ?? caseId}`;
  const body = [
    `Yiji V2 escalated compensation case #${caseId} (order ${p.order_number ?? '?'}${total ? `, ${total}` : ''}).`,
    p.escalation_condition
      ? `Condition: ${p.escalation_condition}${p.escalation_condition_known === false ? ' (amount not known in the order currency - V2 escalated rather than guess)' : ''}.`
      : null,
    'Open the ticket to see the case. Every case still needs an agent’s approval.',
  ]
    .filter(Boolean)
    .join(' ');
  await Promise.all(
    recipients.map((recipientId) =>
      deps.notificationsQueue!.add(
        'compensation-escalated',
        {
          recipientId,
          type: 'escalation',
          title,
          body,
          link: `/tickets/${ticketId}`,
          payload: {
            kind: 'compensation_escalated',
            caseId,
            ticketId,
            escalateTo: p.escalate_to ?? null,
          },
        } satisfies NotificationJob,
        { jobId: `compensation-escalated-${caseId}-${recipientId}` },
      ),
    ),
  );
  logger.info(
    { caseId, escalateTo: p.escalate_to, roles, told: recipients.length },
    'yiji2 compensation escalated: notified',
  );
  return 'escalation-sent';
}
