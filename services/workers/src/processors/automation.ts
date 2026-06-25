import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, updateItem, createItem } from '@directus/sdk';
import {
  AUTOMATION_MAX_DEPTH,
  type AutomationJob,
  type AutomationTrigger,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';

/**
 * Automation processor.
 *
 * Each job is one trigger firing against an entity. We:
 *   1. Load active rules for the trigger, ordered by priority.
 *   2. For each rule, evaluate its conditions against the job context.
 *   3. Run its actions in order, recording an `automation_triggered`
 *      ticket_event (if the entity is a ticket) and bumping the rule's
 *      trigger_count.
 *   4. Loop-prevent via job._depth — any action that re-enqueues an
 *      automation job inherits depth+1; jobs at AUTOMATION_MAX_DEPTH
 *      stop firing.
 *
 * Conditions: a JSON array of `{field, op, value}`. All must pass (AND).
 *   ops: eq, neq, contains, starts_with, gt, lt, in
 *
 * Actions: a JSON array of `{kind, params}` evaluated in order.
 *   kinds: assign_team, assign_agent, set_priority, set_status, add_tag,
 *          send_notification.
 */

export interface AutomationDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  notificationsQueue: Queue;
  automationQueue: Queue;
}

export interface AutomationRuleRow {
  id: string;
  name: string;
  trigger_event: AutomationTrigger;
  conditions: Array<{ field: string; op: string; value: unknown }> | null;
  actions: Array<{ kind: string; params: Record<string, unknown> }> | null;
  active: boolean;
  priority: number;
  trigger_count: number;
}

/** Pluck a nested field (`a.b.c`) from a context object. */
function pluck(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Evaluate a single condition. */
export function evalCondition(
  ctx: unknown,
  c: { field: string; op: string; value: unknown },
): boolean {
  const lhs = pluck(ctx, c.field);
  const rhs = c.value;
  switch (c.op) {
    case 'eq':
      return lhs === rhs;
    case 'neq':
      return lhs !== rhs;
    case 'contains':
      return (
        typeof lhs === 'string' &&
        typeof rhs === 'string' &&
        lhs.toLowerCase().includes(rhs.toLowerCase())
      );
    case 'starts_with':
      return (
        typeof lhs === 'string' &&
        typeof rhs === 'string' &&
        lhs.toLowerCase().startsWith(rhs.toLowerCase())
      );
    case 'gt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case 'lt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case 'in':
      return Array.isArray(rhs) && rhs.includes(lhs);
    default:
      return false;
  }
}

/** All conditions must pass; empty/null = always match. */
export function evalAllConditions(
  ctx: unknown,
  conditions: Array<{ field: string; op: string; value: unknown }> | null | undefined,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evalCondition(ctx, c));
}

async function executeAction(
  action: { kind: string; params: Record<string, unknown> },
  job: Job<AutomationJob>,
  deps: AutomationDeps,
): Promise<void> {
  const { entity, context } = job.data;
  const { directus, notificationsQueue, logger } = deps;
  const entityType = entity.type as 'conversation' | 'ticket' | string;
  const entityId = entity.id;

  switch (action.kind) {
    case 'assign_team':
      if (entityType === 'conversation' || entityType === 'ticket') {
        await directus.request(
          updateItem(entityType + 's', entityId, { assigned_team: action.params.teamId } as never),
        );
      }
      return;
    case 'assign_agent':
      if (entityType === 'conversation' || entityType === 'ticket') {
        await directus.request(
          updateItem(entityType + 's', entityId, {
            assigned_agent: action.params.agentId,
          } as never),
        );
      }
      return;
    case 'set_priority':
      if (entityType === 'conversation' || entityType === 'ticket') {
        await directus.request(
          updateItem(entityType + 's', entityId, { priority: action.params.priority } as never),
        );
      }
      return;
    case 'set_status':
      if (entityType === 'conversation' || entityType === 'ticket') {
        await directus.request(
          updateItem(entityType + 's', entityId, { status: action.params.status } as never),
        );
      }
      return;
    case 'add_tag':
      // Junction insert: contacts_tags / conversations_tags. Caller passes tagId.
      if (entityType === 'conversation') {
        await directus.request(
          createItem('conversations_tags', {
            conversations_id: entityId,
            tags_id: action.params.tagId,
          } as never),
        );
      }
      return;
    case 'send_notification':
      await notificationsQueue.add('send', {
        recipientId: action.params.recipientId as string,
        type: (action.params.type as string) ?? 'automation',
        title: (action.params.title as string) ?? 'Automation',
        body: (action.params.body as string) ?? '',
        link: action.params.link as string | undefined,
        payload: { entityId, entityType, automation: true },
      });
      return;
    case 'escalate':
      // Escalate = raise priority (default urgent) on the entity, and notify a
      // recipient if one is configured. Records as an `escalation` notification.
      if (entityType === 'conversation' || entityType === 'ticket') {
        const priority = (action.params.priority as string) ?? 'urgent';
        await directus.request(updateItem(entityType + 's', entityId, { priority } as never));
      }
      if (action.params.recipientId) {
        await notificationsQueue.add('send', {
          recipientId: action.params.recipientId as string,
          type: 'escalation',
          title: (action.params.title as string) ?? 'Escalation',
          body: (action.params.body as string) ?? `Escalated ${entityType} ${entityId}`,
          link: action.params.link as string | undefined,
          payload: { entityId, entityType, automation: true, escalated: true },
        });
      }
      return;
    default:
      logger.warn({ kind: action.kind }, 'unknown automation action — skipped');
      // Touch context so unused-param lint stays happy without losing the
      // signal that downstream actions COULD read context.
      void context;
  }
}

export async function processAutomationJob(
  job: Job<AutomationJob>,
  deps: AutomationDeps,
): Promise<void> {
  const { directus, logger } = deps;
  const { triggerEvent, entity, context, _depth } = job.data;

  if (_depth >= AUTOMATION_MAX_DEPTH) {
    logger.warn({ triggerEvent, entity, _depth }, 'automation depth limit reached — skipping');
    return;
  }

  const rules = (await directus.request(
    readItems('automation_rules', {
      filter: { active: { _eq: true }, trigger_event: { _eq: triggerEvent } },
      sort: ['-priority', 'id'],
      fields: [
        'id',
        'name',
        'trigger_event',
        'conditions',
        'actions',
        'active',
        'priority',
        'trigger_count',
      ],
      limit: -1,
    }),
  )) as AutomationRuleRow[];

  for (const rule of rules) {
    const ctx = { entity, context, trigger: triggerEvent };
    if (!evalAllConditions(ctx, rule.conditions)) continue;
    for (const action of rule.actions ?? []) {
      try {
        await executeAction(action, job, deps);
      } catch (err) {
        logger.error(
          { ruleId: rule.id, kind: action.kind, err: (err as Error).message },
          'automation action failed',
        );
      }
    }
    // Audit: append a ticket_event when the entity is a ticket.
    if (entity.type === 'ticket') {
      try {
        await directus.request(
          createItem('ticket_events', {
            ticket: entity.id,
            event_type: 'automation_triggered',
            payload: { ruleId: rule.id, ruleName: rule.name },
          } as never),
        );
      } catch {
        // Append-only writes can fail in role-restricted envs; don't crash.
      }
    }
    // Counter + last_triggered_at
    try {
      await directus.request(
        updateItem('automation_rules', rule.id, {
          trigger_count: (rule.trigger_count ?? 0) + 1,
          last_triggered_at: new Date().toISOString(),
        } as never),
      );
    } catch {
      /* ignore — telemetry only */
    }
  }
}

/* ── Inactivity sweep ─────────────────────────────────────────────────
 * The `inactivity` trigger has no natural event source — nothing in the
 * realtime path emits it. A recurring sweep finds conversations that have gone
 * quiet past a threshold and enqueues one inactivity automation job each, so
 * admin-configured inactivity rules (reminders, re-assignment, escalation) fire.
 * Idempotent per inactivity period: the jobId is keyed on the conversation +
 * its current last_message_at, so a given quiet period enqueues at most once;
 * a new customer/agent message moves last_message_at and re-arms it.
 */
export interface InactivitySweepDeps {
  directus: YijiDirectusClient;
  automationQueue: Queue;
  logger: Logger;
  thresholdMinutes: number;
}

export async function runInactivitySweep(deps: InactivitySweepDeps): Promise<void> {
  const cutoff = new Date(Date.now() - deps.thresholdMinutes * 60_000).toISOString();
  const stale = (await deps.directus.request(
    readItems('conversations', {
      // `_lt` already excludes nulls; `_and` keeps the two field conditions
      // unambiguous for the SDK's filter serialization.
      filter: {
        _and: [{ status: { _in: ['open', 'pending'] } }, { last_message_at: { _lt: cutoff } }],
      },
      fields: ['id', 'last_message_at'],
      limit: 200,
    }),
  )) as Array<{ id: string; last_message_at: string }>;

  for (const c of stale) {
    const job: AutomationJob = {
      triggerEvent: 'inactivity',
      entity: { type: 'conversation', id: c.id },
      context: { lastMessageAt: c.last_message_at },
      _depth: 0,
    };
    await deps.automationQueue.add('inactivity', job, {
      // BullMQ rejects ':' in custom job ids; last_message_at is an ISO
      // timestamp (contains ':'), so strip all colons from the composed id.
      jobId: `inact-${c.id}-${c.last_message_at}`.replace(/:/g, '-'),
      removeOnComplete: false,
      removeOnFail: false,
    });
  }
  if (stale.length > 0) deps.logger.info({ count: stale.length }, 'inactivity sweep enqueued');
}

const INACTIVITY_SWEEP_NAME = 'inactivity_sweep';

/** Recurring inactivity sweep, scheduled on the automation queue at startup. */
export async function scheduleInactivitySweep(
  automationQueue: Queue,
  everyMs: number,
): Promise<void> {
  await automationQueue.add(
    INACTIVITY_SWEEP_NAME,
    {
      triggerEvent: 'inactivity',
      entity: { type: '__sweep__', id: '__sweep__' },
      context: {},
      _depth: 0,
    } as AutomationJob,
    {
      repeat: { every: everyMs },
      jobId: 'automation-inactivity-sweep',
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export { INACTIVITY_SWEEP_NAME };
