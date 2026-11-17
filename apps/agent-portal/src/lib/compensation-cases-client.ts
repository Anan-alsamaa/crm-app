import type { CompensationCaseRow, Yiji2AgentComplaintCode } from '@yiji/shared-types';
import { resolveUrl } from '@yiji/shared-config';
import { auth } from './directus.js';

/**
 * YIJI V2 COMPENSATION CASES - the agent portal's client (owner, 18 Nov 2026).
 *
 * Calls the AI gateway (never V2): the gateway checks the agent's own session,
 * the ticket and the `approve_compensation_cases` switch, then calls V2 with
 * the partner credential it alone holds. Every write carries the
 * Idempotency-Key the dialog made when it opened, so a double click or a
 * retried request never acts twice on V2.
 */

const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);

export interface TicketCases {
  ticketId: string;
  /** The ticket belongs to a Yiji v2 vendor. */
  v2: boolean;
  /** The ticket's V2 order number, when it has one (enables "Log V2 complaint"). */
  orderNumber: string | null;
  /** The caller holds approve_compensation_cases (or is the Administrator). */
  canAct: boolean;
  cases: CompensationCaseRow[];
}

/** A refusal, in the gateway's words: `reason` on a 409 is V2's. */
export class CaseActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string | null,
    readonly detail: string | null,
    /** The case as V2 now has it (sent back after a 409). */
    readonly fresh: CompensationCaseRow | null,
  ) {
    super(code);
    this.name = 'CaseActionError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await auth.getToken();
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new CaseActionError(
      res.status,
      String(json.error ?? `http_${res.status}`),
      typeof json.reason === 'string' ? json.reason : null,
      typeof json.message === 'string'
        ? json.message
        : typeof json.problem === 'string'
          ? json.problem
          : typeof json.field === 'string'
            ? json.field
            : null,
      (json.case as CompensationCaseRow | undefined) ?? null,
    );
  }
  return (json as { data: T }).data;
}

/** A fresh key for one action (8-100 of [A-Za-z0-9_-]). */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export type CaseAction = 'approve' | 'reject' | 'evidence' | 'verification';

export const compensationCases = {
  forTicket: (ticketId: string) =>
    call<TicketCases>(
      'GET',
      `/commerce/compensation-cases?ticketId=${encodeURIComponent(ticketId)}`,
    ),
  refresh: (caseId: string, ticketId: string) =>
    call<{ case: CompensationCaseRow }>(
      'GET',
      `/commerce/compensation-cases/${encodeURIComponent(caseId)}?ticketId=${encodeURIComponent(ticketId)}`,
    ),
  act: (
    caseId: string,
    action: CaseAction,
    body: {
      ticketId: string;
      idempotencyKey: string;
      reason: string;
      amountMinor?: number;
      result?: 'confirmed' | 'not_confirmed';
    },
  ) =>
    call<{ case: CompensationCaseRow }>(
      'POST',
      `/commerce/compensation-cases/${encodeURIComponent(caseId)}/${action}`,
      body,
    ),
  logComplaint: (body: {
    ticketId: string;
    idempotencyKey: string;
    category: Yiji2AgentComplaintCode;
    hasPhotos: boolean;
    text?: string;
  }) =>
    call<{ case: CompensationCaseRow; ticketId: string | null; onThisTicket: boolean }>(
      'POST',
      '/commerce/compensation-cases',
      body,
    ),
};
