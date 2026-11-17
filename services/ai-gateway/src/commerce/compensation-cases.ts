import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COMPENSATION_CASES_COLLECTION,
  COMPENSATION_CASE_FIELDS,
  YIJI2_AGENT_COMPLAINT_CODES,
  YIJI2_VERIFICATION_RESULTS,
  Yiji2RefusedError,
  Yiji2UnavailableError,
  caseFieldsFromWire,
  compensationCasesOf,
  isUnknownVendor,
  isYiji2OrderNumber,
  mergeCaseStatus,
  yiji2CaseConflictMessage,
  yiji2OverrideCurrency,
  yiji2OverrideProblem,
  type CompensationCaseAction,
  type CompensationCasePatch,
  type CompensationCaseRow,
  type ConnectorRegistry,
  type Yiji2CompensationCaseWire,
  type Yiji2CompensationCases,
} from '@yiji/shared-types';
import {
  actorHolds,
  bearerOf,
  type SessionActor,
  type SessionActorResolver,
} from '../auth/session-actor.js';

/**
 * YIJI V2 COMPENSATION CASES - the agent portal's routes (owner, 18 Nov 2026;
 * contract `auto-compensation-contract.md` section 3).
 *
 *   GET  /commerce/compensation-cases?ticketId=          the ticket's cases
 *   GET  /commerce/compensation-cases/:caseId?ticketId=  re-read one from V2
 *   POST /commerce/compensation-cases                    log a V2 complaint
 *   POST /commerce/compensation-cases/:caseId/approve    | reject | evidence | verification
 *
 * Same shape as every vendor action the gateway proxies: the caller's OWN
 * Directus session says who they are and what they hold (`/users/me` + their
 * `app_roles` privileges); the ticket must be one THEY can read (their token);
 * the V2 partner credential never leaves this service. Every action needs the
 * `approve_compensation_cases` privilege (off for every role by default; the
 * Administrator always). Reading the ticket's cases needs only the ticket.
 *
 * WHO acted comes from the session, never the body: `agent_id` sent to V2 is
 * the CRM user id. A case is acted on only from the ticket it is linked to.
 * V2's answer is written to the case row at once (the event that follows
 * finds the same values), with the action, its reason and V2's verdict in
 * `agent_actions`.
 *
 * Yiji v2 only. A ticket of any other platform answers `v2: false` and every
 * action on it is refused - v1 is untouched.
 */

export const APPROVE_COMPENSATION_CASES = 'approve_compensation_cases';

/** What the routes need from Directus, with the gateway's service account. */
export interface CompensationCaseStore {
  ticket(
    id: string,
  ): Promise<{ id: string; vendor: string | null; order_id: string | null } | null>;
  vendorPlatform(vendorId: string): Promise<string | null>;
  casesForTicket(ticketId: string): Promise<CompensationCaseRow[]>;
  caseById(caseId: string): Promise<CompensationCaseRow | null>;
  createCase(row: CompensationCasePatch): Promise<CompensationCaseRow>;
  updateCase(rowId: string, patch: CompensationCasePatch): Promise<CompensationCaseRow>;
}

export interface CompensationCaseRoutesDeps {
  sessions: SessionActorResolver;
  store: CompensationCaseStore;
  connectors: Pick<ConnectorRegistry, 'connectorFor'>;
  now?: () => number;
  /** Actions per signed-in user per minute. */
  perUserPerMin?: number;
}

export class CaseStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CaseStoreError';
  }
}

/** The service-account store (svc-ai-gateway: tickets id/vendor/order_id read; cases c/r/u). */
export class DirectusCompensationCaseStore implements CompensationCaseStore {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(
    directusUrl: string,
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    this.base = directusUrl.replace(/\/+$/, '');
    this.f = fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok)
      throw new CaseStoreError(
        `directus ${method} ${path.split('?')[0]} ${res.status}`,
        res.status,
      );
    const out = (await res.json().catch(() => ({}))) as { data?: T };
    return (out.data ?? null) as T | null;
  }

  private q(filter: unknown, fields: readonly string[], limit = -1): string {
    return new URLSearchParams({
      filter: JSON.stringify(filter),
      fields: fields.join(','),
      limit: String(limit),
    }).toString();
  }

  async ticket(id: string) {
    return this.req<{ id: string; vendor: string | null; order_id: string | null }>(
      'GET',
      `/items/tickets/${encodeURIComponent(id)}?fields=id,vendor,order_id`,
    );
  }
  async vendorPlatform(vendorId: string) {
    const v = await this.req<{ platform?: string | null }>(
      'GET',
      `/items/vendors/${encodeURIComponent(vendorId)}?fields=platform`,
    );
    return v ? v.platform?.trim() || 'yiji' : null;
  }
  async casesForTicket(ticketId: string) {
    const rows = await this.req<CompensationCaseRow[]>(
      'GET',
      `/items/${COMPENSATION_CASES_COLLECTION}?${this.q({ ticket: { _eq: ticketId } }, COMPENSATION_CASE_FIELDS)}&sort=-expires_at`,
    );
    return rows ?? [];
  }
  async caseById(caseId: string) {
    const rows = await this.req<CompensationCaseRow[]>(
      'GET',
      `/items/${COMPENSATION_CASES_COLLECTION}?${this.q({ case_id: { _eq: caseId } }, COMPENSATION_CASE_FIELDS, 1)}`,
    );
    return rows?.[0] ?? null;
  }
  async createCase(row: CompensationCasePatch) {
    const out = await this.req<CompensationCaseRow>(
      'POST',
      `/items/${COMPENSATION_CASES_COLLECTION}?fields=${COMPENSATION_CASE_FIELDS.join(',')}`,
      row,
    );
    if (!out) throw new CaseStoreError('directus create answered nothing', 502);
    return out;
  }
  async updateCase(rowId: string, patch: CompensationCasePatch) {
    const out = await this.req<CompensationCaseRow>(
      'PATCH',
      `/items/${COMPENSATION_CASES_COLLECTION}/${encodeURIComponent(rowId)}?fields=${COMPENSATION_CASE_FIELDS.join(',')}`,
      patch,
    );
    if (!out) throw new CaseStoreError('directus update answered nothing', 502);
    return out;
  }
}

/* ── Bodies ─────────────────────────────────────────────────────────────── */

const ticketId = z.string().trim().min(1).max(64);
/** One per click (the portal makes it when the dialog opens): a retried click never acts twice. */
const idempotencyKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,100}$/);
const reason = z.string().trim().min(1).max(500);

const LogBody = z
  .object({
    ticketId,
    idempotencyKey,
    category: z.enum(YIJI2_AGENT_COMPLAINT_CODES),
    affectedItems: z
      .array(
        z
          .object({
            orderItemId: z
              .string()
              .trim()
              .regex(/^\d{1,20}$/),
            quantity: z.number().int().min(1).max(999).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    hasPhotos: z.boolean().optional(),
    text: z.string().trim().max(1000).optional(),
  })
  .strict();

const ActionBodies = {
  approve: z
    .object({
      ticketId,
      idempotencyKey,
      reason,
      amountMinor: z.number().int().optional(),
    })
    .strict(),
  reject: z.object({ ticketId, idempotencyKey, reason }).strict(),
  evidence: z.object({ ticketId, idempotencyKey, reason }).strict(),
  verification: z
    .object({ ticketId, idempotencyKey, reason, result: z.enum(YIJI2_VERIFICATION_RESULTS) })
    .strict(),
} as const;
type ActionName = keyof typeof ActionBodies;

/* ── Errors, in the portal's words ──────────────────────────────────────── */

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

function refusalOf(err: unknown): Refusal | null {
  if (isUnknownVendor(err))
    /* The v2 vendor is inactive (or gone): nothing is sent anywhere. */
    return { status: 404, body: { error: 'unknown_vendor' } };
  if (err instanceof Yiji2RefusedError) {
    if (err.status === 409)
      return {
        status: 409,
        body: {
          error: 'conflict',
          reason: err.reason ?? null,
          message: yiji2CaseConflictMessage(err.reason),
        },
      };
    if (err.status === 404) return { status: 404, body: { error: 'not_found_on_v2' } };
    if (err.status === 401 || err.status === 403)
      return { status: 502, body: { error: 'v2_forbidden' } };
    return {
      status: 400,
      body: {
        error: 'refused',
        code: err.code,
        field: err.field,
        message: err.message,
        ...(err.traceId ? { traceId: err.traceId } : {}),
      },
    };
  }
  if (err instanceof Yiji2UnavailableError)
    return {
      status: 503,
      body: { error: 'v2_unavailable', retryAfterSec: err.retryAfterSec ?? null },
    };
  if (err instanceof CaseStoreError)
    return { status: 503, body: { error: 'directus_unavailable' } };
  return null;
}

const outcomeOf = (r: Refusal | null): CompensationCaseAction['outcome'] =>
  !r ? 'ok' : r.status === 503 ? 'unavailable' : 'refused';

export async function registerCompensationCaseRoutes(
  app: FastifyInstance,
  deps: CompensationCaseRoutesDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const limit = deps.perUserPerMin ?? 60;
  const recent = new Map<string, number[]>();

  type Door =
    | { ok: true; actor: SessionActor; token: string }
    | { ok: false; status: number; error: string };

  async function door(req: FastifyRequest, needsPrivilege: boolean): Promise<Door> {
    const token = bearerOf(req.headers.authorization);
    if (!token) return { ok: false, status: 401, error: 'unauthenticated' };
    const actor = await deps.sessions.resolve(token);
    if (actor === 'unavailable') return { ok: false, status: 503, error: 'directus_unavailable' };
    if (!actor) return { ok: false, status: 401, error: 'unauthenticated' };
    if (needsPrivilege && !actorHolds(actor, APPROVE_COMPENSATION_CASES))
      return { ok: false, status: 403, error: 'approve_compensation_cases_required' };
    const times = (recent.get(actor.id) ?? []).filter((t) => now() - t < 60_000);
    if (times.length >= limit) return { ok: false, status: 429, error: 'rate_limited' };
    times.push(now());
    recent.set(actor.id, times);
    if (recent.size > 5000) recent.delete(recent.keys().next().value as string);
    return { ok: true, actor, token };
  }

  /** The ticket, when the CALLER may read it and it belongs to a v2 vendor. */
  async function v2Ticket(
    token: string,
    id: string,
  ): Promise<
    | { ok: true; ticket: { id: string; vendor: string; order_id: string | null } }
    | { ok: false; status: number; error: string; v2?: false }
  > {
    const visible = await deps.sessions.canRead(token, 'tickets', id);
    if (visible === 'unavailable') return { ok: false, status: 503, error: 'directus_unavailable' };
    if (!visible) return { ok: false, status: 404, error: 'ticket_not_found' };
    const t = await deps.store.ticket(id);
    if (!t) return { ok: false, status: 404, error: 'ticket_not_found' };
    const platform = t.vendor ? await deps.store.vendorPlatform(t.vendor) : null;
    if (platform !== 'yiji2' || !t.vendor)
      return { ok: false, status: 409, error: 'not_a_v2_ticket', v2: false };
    return { ok: true, ticket: { id: t.id, vendor: t.vendor, order_id: t.order_id } };
  }

  async function casesApi(vendor: string): Promise<Yiji2CompensationCases> {
    const api = compensationCasesOf(await deps.connectors.connectorFor(vendor));
    /* An active v2 vendor without credentials: nothing can be sent. */
    if (!api) throw new Yiji2UnavailableError('yiji2 connector not configured');
    return api;
  }

  /** V2's answer -> the case row (created on the ticket when it is new). */
  async function record(
    wire: Yiji2CompensationCaseWire,
    link: { vendor: string; ticket: string },
    action?: CompensationCaseAction,
  ): Promise<CompensationCaseRow> {
    const fields = caseFieldsFromWire(wire as unknown as Record<string, unknown>);
    const caseId = fields.case_id!;
    const stored = await deps.store.caseById(caseId);
    const actions = [...(stored?.agent_actions ?? []), ...(action ? [action] : [])].slice(-50);
    const patch: CompensationCasePatch = {
      ...fields,
      status: mergeCaseStatus(stored?.status, fields.status),
      ...(action ? { agent_actions: actions } : {}),
    };
    delete patch.case_id;
    if (stored) return deps.store.updateCase(stored.id, patch);
    try {
      return await deps.store.createCase({
        ...patch,
        case_id: caseId,
        vendor: link.vendor,
        ticket: link.ticket,
      });
    } catch (err) {
      /* The events job created it first (unique case_id): update that row. */
      const raced = await deps.store.caseById(caseId).catch(() => null);
      if (!raced) throw err;
      return deps.store.updateCase(raced.id, {
        ...patch,
        ...(raced.ticket ? {} : { ticket: link.ticket }),
        agent_actions: [...(raced.agent_actions ?? []), ...(action ? [action] : [])].slice(-50),
      });
    }
  }

  async function noteAction(row: CompensationCaseRow, action: CompensationCaseAction) {
    try {
      await deps.store.updateCase(row.id, {
        agent_actions: [...(row.agent_actions ?? []), action].slice(-50),
      });
    } catch (err) {
      app.log.warn({ caseId: row.case_id, err: (err as Error)?.message }, 'case action not noted');
    }
  }

  const fail = (reply: FastifyReply, status: number, error: string, extra = {}) =>
    reply.code(status).send({ error, ...extra });

  /* ── The ticket's cases (the panel; no privilege beyond the ticket) ──── */
  app.get('/commerce/compensation-cases', async (req, reply) => {
    const d = await door(req, false);
    if (!d.ok) return fail(reply, d.status, d.error);
    const id = ticketId.safeParse((req.query as { ticketId?: unknown })?.ticketId);
    if (!id.success) return fail(reply, 400, 'ticketId_required');
    try {
      const visible = await deps.sessions.canRead(d.token, 'tickets', id.data);
      if (visible === 'unavailable') return fail(reply, 503, 'directus_unavailable');
      if (!visible) return fail(reply, 404, 'ticket_not_found');
      const t = await deps.store.ticket(id.data);
      if (!t) return fail(reply, 404, 'ticket_not_found');
      const platform = t.vendor ? await deps.store.vendorPlatform(t.vendor) : null;
      const v2 = platform === 'yiji2';
      const cases = v2 ? await deps.store.casesForTicket(t.id) : [];
      return reply.send({
        data: {
          ticketId: t.id,
          v2,
          orderNumber: v2 && isYiji2OrderNumber(t.order_id) ? t.order_id : null,
          canAct: actorHolds(d.actor, APPROVE_COMPENSATION_CASES),
          cases,
        },
      });
    } catch (err) {
      const r = refusalOf(err);
      if (r) return reply.code(r.status).send(r.body);
      throw err;
    }
  });

  /* ── Log a V2 complaint from a v2 ticket that has an order ──────────── */
  app.post('/commerce/compensation-cases', async (req, reply) => {
    const d = await door(req, true);
    if (!d.ok) return fail(reply, d.status, d.error);
    const body = LogBody.safeParse(req.body);
    if (!body.success)
      return fail(reply, 400, 'invalid_body', { field: body.error.issues[0]?.path.join('.') });
    try {
      const tk = await v2Ticket(d.token, body.data.ticketId);
      if (!tk.ok) return fail(reply, tk.status, tk.error);
      const order = tk.ticket.order_id;
      if (!isYiji2OrderNumber(order)) return fail(reply, 409, 'ticket_has_no_v2_order');
      const api = await casesApi(tk.ticket.vendor);
      const b = body.data;
      const wire = await api.logComplaint(
        {
          order_number: String(order),
          category: b.category,
          agent_id: d.actor.id,
          ...(b.affectedItems?.length
            ? {
                affected_items: b.affectedItems.map((i) => ({
                  order_item_id: i.orderItemId,
                  ...(i.quantity ? { quantity: i.quantity } : {}),
                })),
              }
            : {}),
          has_photos: b.hasPhotos === true,
          ...(b.text ? { text: b.text } : {}),
        },
        b.idempotencyKey,
      );
      const row = await record(
        wire,
        { vendor: tk.ticket.vendor, ticket: tk.ticket.id },
        {
          action: 'log',
          by: d.actor.id,
          at: new Date(now()).toISOString(),
          ...(b.text ? { reason: b.text.slice(0, 500) } : {}),
          outcome: 'ok',
          detail: b.category,
        },
      );
      req.log.info(
        { caseId: row.case_id, ticketId: tk.ticket.id, by: d.actor.id, category: b.category },
        'v2 compensation complaint logged',
      );
      return reply.send({
        data: { case: row, ticketId: row.ticket, onThisTicket: row.ticket === tk.ticket.id },
      });
    } catch (err) {
      const r = refusalOf(err);
      if (r) return reply.code(r.status).send(r.body);
      throw err;
    }
  });

  /** The case, when it is linked to the ticket the caller may read. */
  async function caseOnTicket(
    token: string,
    caseId: string,
    tkId: string,
  ): Promise<
    | { ok: true; row: CompensationCaseRow; vendor: string }
    | { ok: false; status: number; error: string }
  > {
    if (!/^\d{1,20}$/.test(caseId)) return { ok: false, status: 400, error: 'invalid_case_id' };
    const tk = await v2Ticket(token, tkId);
    if (!tk.ok) return tk;
    const row = await deps.store.caseById(caseId);
    if (!row || row.ticket !== tk.ticket.id)
      return { ok: false, status: 404, error: 'case_not_on_ticket' };
    return { ok: true, row, vendor: row.vendor ?? tk.ticket.vendor };
  }

  /* ── Re-read one case from V2 ─────────────────────────────────────────── */
  app.get('/commerce/compensation-cases/:caseId', async (req, reply) => {
    const d = await door(req, true);
    if (!d.ok) return fail(reply, d.status, d.error);
    const { caseId } = req.params as { caseId: string };
    const id = ticketId.safeParse((req.query as { ticketId?: unknown })?.ticketId);
    if (!id.success) return fail(reply, 400, 'ticketId_required');
    try {
      const c = await caseOnTicket(d.token, caseId, id.data);
      if (!c.ok) return fail(reply, c.status, c.error);
      const wire = await (await casesApi(c.vendor)).get(caseId);
      if (!wire) return fail(reply, 404, 'not_found_on_v2');
      const row = await record(wire, { vendor: c.vendor, ticket: c.row.ticket! });
      return reply.send({ data: { case: row } });
    } catch (err) {
      const r = refusalOf(err);
      if (r) return reply.code(r.status).send(r.body);
      throw err;
    }
  });

  /* ── Approve / reject / photos received / camera check done ──────────── */
  for (const action of Object.keys(ActionBodies) as ActionName[]) {
    app.post(`/commerce/compensation-cases/:caseId/${action}`, async (req, reply) => {
      const d = await door(req, true);
      if (!d.ok) return fail(reply, d.status, d.error);
      const { caseId } = req.params as { caseId: string };
      const parsed = ActionBodies[action].safeParse(req.body);
      if (!parsed.success)
        return fail(reply, 400, 'invalid_body', { field: parsed.error.issues[0]?.path.join('.') });
      const b = parsed.data as {
        ticketId: string;
        idempotencyKey: string;
        reason: string;
        amountMinor?: number;
        result?: 'confirmed' | 'not_confirmed';
      };
      let c: Awaited<ReturnType<typeof caseOnTicket>>;
      try {
        c = await caseOnTicket(d.token, caseId, b.ticketId);
      } catch (err) {
        const r = refusalOf(err);
        if (r) return reply.code(r.status).send(r.body);
        throw err;
      }
      if (!c.ok) return fail(reply, c.status, c.error);
      const row = c.row;

      /* The override is checked here first (V2 checks it again). */
      let amount: { amount_minor: number; currency: string } | undefined;
      if (action === 'approve' && b.amountMinor !== undefined) {
        const problem = yiji2OverrideProblem(b.amountMinor, row);
        const currency = yiji2OverrideCurrency(row);
        if (problem || !currency)
          return fail(reply, 400, 'invalid_amount', { problem: problem ?? 'currency_unknown' });
        amount = { amount_minor: b.amountMinor, currency };
      }

      const base: CompensationCaseAction = {
        action,
        by: d.actor.id,
        at: new Date(now()).toISOString(),
        reason: b.reason,
        outcome: 'ok',
        ...(amount ? { amount_minor: amount.amount_minor } : {}),
        ...(b.result ? { result: b.result } : {}),
      };
      try {
        const api = await casesApi(c.vendor);
        const agent = d.actor.id;
        const wire =
          action === 'approve'
            ? await api.approve(
                caseId,
                { agent_id: agent, reason: b.reason, ...(amount ? { amount } : {}) },
                b.idempotencyKey,
              )
            : action === 'reject'
              ? await api.reject(caseId, { agent_id: agent, reason: b.reason }, b.idempotencyKey)
              : action === 'evidence'
                ? await api.evidence(caseId, { agent_id: agent }, b.idempotencyKey)
                : await api.verification(
                    caseId,
                    { agent_id: agent, result: b.result!, note: b.reason },
                    b.idempotencyKey,
                  );
        const saved = await record(wire, { vendor: c.vendor, ticket: row.ticket! }, base);
        req.log.info(
          { caseId, action, by: agent, status: saved.status, overridden: !!amount },
          'v2 compensation case action',
        );
        return reply.send({ data: { case: saved } });
      } catch (err) {
        const r = refusalOf(err);
        if (!r) throw err;
        const noted: CompensationCaseAction = {
          ...base,
          outcome: outcomeOf(r),
          detail: String(r.body.reason ?? r.body.code ?? r.body.error ?? '').slice(0, 120),
        };
        /* After a 409 the case moved on V2 (expired, failed, decided): show it. */
        let fresh: CompensationCaseRow | null = null;
        if (r.status === 409) {
          try {
            const wire = await (await casesApi(c.vendor)).get(caseId);
            if (wire) fresh = await record(wire, { vendor: c.vendor, ticket: row.ticket! }, noted);
          } catch {
            /* the refusal is still the answer */
          }
        }
        if (!fresh) await noteAction(row, noted);
        req.log.warn({ caseId, action, by: d.actor.id, refusal: r.body }, 'v2 case action refused');
        return reply.code(r.status).send({ ...r.body, ...(fresh ? { case: fresh } : {}) });
      }
    });
  }
}
