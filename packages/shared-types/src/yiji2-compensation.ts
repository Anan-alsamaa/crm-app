import { z } from 'zod';
import type { Yiji2EventEnvelope } from './order-events.js';

/**
 * YIJI V2 AUTOMATIC COMPENSATION - the CRM side (owner, 18 Nov 2026).
 *
 * Contract: yiji-platform `docs/integrations/crm/auto-compensation-contract.md`
 * (2026-11-17, second pass), `api/openapi/partner-v1.yaml` (paths
 * `/compensation-cases*`) and `api/openapi/crm-events-v1.yaml`
 * (`compensation.proposed`, `compensation.decided`, `compensation.escalated`).
 *
 *   - V2 computes each case from the owner's compensation policy;
 *   - EVERY case needs one approval by a CRM agent (`/approve` or `/reject`);
 *   - V2 then issues (wallet credit or coupon) and messages the customer;
 *   - a case expires 72 hours after it was proposed (or after its photos).
 *
 * This file holds what the gateway, the workers and the portal share and is
 * free of runtime dependencies on the connector: the vocabularies, the event
 * jobs, the CRM row a case is stored as, the 409 reasons and their messages,
 * the amount-override limits and the escalation-recipient setting.
 *
 * Yiji v2 ONLY. Nothing here is read for a Yiji v1 ticket, coupon or customer.
 * The CRM's own `compensation_rules` are unrelated and unchanged (V2 no longer
 * reads them).
 */

/* ── Vocabularies (partner-v1.yaml, CompensationCase) ─────────────────── */

/**
 * The AGENT rule codes an agent may log a complaint under
 * (`POST /compensation-cases`, `category`). The policy's AUTO rows (DLY,
 * PRP-DEL, PRP-PU) are opened by V2 itself and are not offered.
 */
export const YIJI2_AGENT_COMPLAINT_CODES = [
  'HAIR',
  'FOREIGN',
  'PRD-1',
  'PRD-2',
  'ACC-1',
  'ACC-2',
  'ACC-3',
  'HOS',
  'LBL',
  'CUT',
  'MIS',
  'KID',
  'MEL',
  'REM',
  'SID',
  'GRP',
  'BOGO',
] as const;
export type Yiji2AgentComplaintCode = (typeof YIJI2_AGENT_COMPLAINT_CODES)[number];

export function isYiji2AgentComplaintCode(v: unknown): v is Yiji2AgentComplaintCode {
  return typeof v === 'string' && (YIJI2_AGENT_COMPLAINT_CODES as readonly string[]).includes(v);
}

/**
 * The AGENT categories PAID ON THE AFFECTED ITEMS from their first occurrence
 * (V2 policy `rules.csv`, action ITEM_VALUE / ITEM_PCT on the ALL, O1 and O2
 * rows): V2 answers `400` "a category paid on items without items"
 * (auto-compensation-contract.md section 3). The CRM asks for at least one
 * line before it sends one of these.
 */
export const YIJI2_ITEM_PAID_CATEGORIES: readonly Yiji2AgentComplaintCode[] = [
  'PRD-1',
  'PRD-2',
  'ACC-1',
  'ACC-2',
  'MIS',
  'REM',
];

/**
 * Paid on the items only from the SECOND occurrence (rules.csv HAIR-O2,
 * FOREIGN-O2: ITEM_VALUE; O1 is the full order). The CRM cannot know the
 * occurrence before V2 counts it, so items are optional here and the form
 * advises naming them; V2 refuses an O2 without items with its 400.
 */
export const YIJI2_ITEM_PAID_FROM_SECOND: readonly Yiji2AgentComplaintCode[] = ['HAIR', 'FOREIGN'];

export function isYiji2ItemPaidCategory(v: unknown): boolean {
  return typeof v === 'string' && (YIJI2_ITEM_PAID_CATEGORIES as readonly string[]).includes(v);
}

/** One order line as the picker and the gateway see it (from the v2 order read). */
export interface Yiji2PickableLine {
  /** `OrderItem.order_item_id`: the order line id. */
  orderItemId: string;
  quantity: number;
}

/** One picked line: `affected_items[]` in the CRM's words. */
export interface Yiji2PickedItem {
  orderItemId: string;
  /** Affected units, 1..the line's quantity; absent = the whole line. */
  quantity?: number;
}

export type Yiji2AffectedItemsProblem =
  | 'items_required'
  | 'too_many_items'
  | 'item_not_on_order'
  | 'item_twice'
  | 'item_quantity';

/**
 * The affected items against the order's lines, before anything reaches V2
 * (V2 checks the same and answers 400): every id a line of THIS order (never
 * the catalogue id, never another order's line), each once, the quantity
 * 1..the line's quantity; at least one for a category paid on items. `null`
 * when the pick is fine. `index` names the first bad entry.
 */
export function yiji2AffectedItemsProblem(
  category: string,
  picked: readonly Yiji2PickedItem[] | null | undefined,
  lines: readonly Yiji2PickableLine[],
): { problem: Yiji2AffectedItemsProblem; index?: number } | null {
  const list = picked ?? [];
  if (list.length === 0)
    return isYiji2ItemPaidCategory(category) ? { problem: 'items_required' } : null;
  if (list.length > 50) return { problem: 'too_many_items' };
  const seen = new Set<string>();
  for (const [index, p] of list.entries()) {
    const line = lines.find((l) => l.orderItemId === String(p.orderItemId).trim());
    if (!line) return { problem: 'item_not_on_order', index };
    if (seen.has(line.orderItemId)) return { problem: 'item_twice', index };
    seen.add(line.orderItemId);
    if (
      p.quantity !== undefined &&
      (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > line.quantity)
    )
      return { problem: 'item_quantity', index };
  }
  return null;
}

export const YIJI2_CASE_STATUSES = [
  'evidence_hold',
  'proposed',
  'needs_bhd_value',
  'approved',
  'rejected',
  'expired',
  'failed',
] as const;
export type Yiji2CaseStatus = (typeof YIJI2_CASE_STATUSES)[number];

/** A case in one of these states is decided: nothing can change it any more. */
export const YIJI2_CASE_TERMINAL_STATUSES: ReadonlySet<string> = new Set<Yiji2CaseStatus>([
  'approved',
  'rejected',
  'expired',
  'failed',
]);

export const YIJI2_CASE_DECISIONS = ['approved', 'rejected', 'expired', 'failed'] as const;
export type Yiji2CaseDecision = (typeof YIJI2_CASE_DECISIONS)[number];

export const YIJI2_CASE_ACTION_TYPES = [
  'FIXED',
  'FULL_ORDER',
  'ITEM_VALUE',
  'ITEM_PCT',
  'ORDER_PCT',
  'MAX_FIXED_OR_ITEM',
  'ITEM_OR_HALF_ORDER',
  'COUPON_FIXED',
  'COUPON_PCT',
  'COUPON_ORDER_PCT',
  'APOLOGY_ONLY',
  'VERIFY_CCTV',
] as const;

export const YIJI2_VERIFICATION_RESULTS = ['confirmed', 'not_confirmed'] as const;
export type Yiji2VerificationResult = (typeof YIJI2_VERIFICATION_RESULTS)[number];

/** How long V2 keeps a case open (contract section 2): 72 hours. */
export const YIJI2_CASE_LIFETIME_MS = 72 * 60 * 60 * 1000;

/* ── 409 reasons (partner-v1.yaml: `409 INVALID_TRANSITION`, `data.reason`) ── */

/**
 * Why V2 refused a transition. `no_verification` is the `/verification`
 * route's own (a case without a camera review task).
 */
export const YIJI2_CASE_CONFLICT_REASONS = [
  'closed',
  'expired',
  'evidence_hold',
  'needs_bhd_value',
  'failed',
  'not_held',
  'no_verification',
] as const;
export type Yiji2CaseConflictReason = (typeof YIJI2_CASE_CONFLICT_REASONS)[number];

/**
 * The English an agent reads for each 409 reason. The portal translates by
 * the reason code (`v2Case.conflict.<reason>`); this is the fallback and what
 * the gateway puts in its answer.
 */
export const YIJI2_CASE_CONFLICT_MESSAGES: Readonly<Record<Yiji2CaseConflictReason, string>> = {
  closed: 'This case is already closed (rejected, expired or failed). Nothing more can be done.',
  expired: 'This case passed its 72 hours. It can no longer be approved.',
  evidence_hold:
    'This case is waiting for photos. Check the photos, then use "Photos received" before approving.',
  needs_bhd_value:
    'Yiji V2 has no Bahraini dinar value for this rule yet. The case can only be rejected.',
  failed:
    'Yiji V2 could not issue the compensation (a coupon check refused it). The case is now failed.',
  not_held: 'This case is not waiting for photos.',
  no_verification: 'This case has no camera check to close.',
};

/** The message for a 409 reason; an unknown reason gets a general sentence that names it. */
export function yiji2CaseConflictMessage(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if ((YIJI2_CASE_CONFLICT_REASONS as readonly string[]).includes(r))
    return YIJI2_CASE_CONFLICT_MESSAGES[r as Yiji2CaseConflictReason];
  return r
    ? `Yiji V2 refused this action (${r}).`
    : 'Yiji V2 refused this action in the case’s current state.';
}

/* ── Partner API bodies (what the connector sends) ─────────────────────── */

/** `agent_id` is the CRM user id: at most 64 characters (partner-v1.yaml). */
const agentId = z.string().trim().min(1).max(64);

export const Yiji2CaseComplaintBody = z
  .object({
    order_number: z
      .string()
      .trim()
      .regex(/^\d{6,20}$/),
    category: z.enum(YIJI2_AGENT_COMPLAINT_CODES),
    agent_id: agentId,
    affected_items: z
      .array(
        z
          .object({
            /* partner-v1.yaml `ID`: an int64 line id (sent to V2 as a JSON number). */
            order_item_id: z.union([
              z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              z
                .string()
                .trim()
                .regex(/^[1-9]\d{0,14}$/),
            ]),
            quantity: z.number().int().min(1).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    has_photos: z.boolean().optional(),
    text: z.string().max(1000).optional(),
  })
  .strict();
export type Yiji2CaseComplaintBody = z.infer<typeof Yiji2CaseComplaintBody>;

export const Yiji2MoneyBody = z
  .object({
    amount_minor: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const Yiji2CaseDecisionBody = z
  .object({
    agent_id: agentId,
    reason: z.string().trim().min(1).max(500),
    amount: Yiji2MoneyBody.optional(),
  })
  .strict();
export type Yiji2CaseDecisionBody = z.infer<typeof Yiji2CaseDecisionBody>;

export const Yiji2CaseAgentBody = z.object({ agent_id: agentId }).strict();
export type Yiji2CaseAgentBody = z.infer<typeof Yiji2CaseAgentBody>;

export const Yiji2CaseVerificationBody = z
  .object({
    agent_id: agentId,
    result: z.enum(YIJI2_VERIFICATION_RESULTS),
    note: z.string().max(500).optional(),
  })
  .strict();
export type Yiji2CaseVerificationBody = z.infer<typeof Yiji2CaseVerificationBody>;

/* ── The case as V2 answers it (partner-v1.yaml CompensationCase) ──────── */

export interface Yiji2MoneyWire {
  amount_minor: number;
  currency: string;
}

export interface Yiji2CompensationCaseWire {
  id: string | number;
  policy_version?: number;
  row_key: string;
  rule_code?: string;
  trigger_mode?: 'AUTO' | 'AGENT';
  source?: 'auto' | 'app' | 'agent';
  status: Yiji2CaseStatus;
  customer_id?: string | number;
  order_number: string | number;
  brand_id?: string | number;
  restaurant_id?: string | number;
  country?: string;
  order_type?: string;
  order_total?: Yiji2MoneyWire;
  metric_minutes?: number;
  counter_group?: string;
  occurrence?: number;
  affected_items?: Array<{
    order_item_id: string | number;
    quantity: number;
    line_quantity?: number;
    line_total_minor?: number;
    unit_price_minor?: number;
  }>;
  has_photos?: boolean;
  text?: string;
  logged_by_agent?: string;
  action_type?: string;
  comp_method?: string;
  amount?: Yiji2MoneyWire;
  percent_bps?: number;
  calculation?: Record<string, string>;
  stacked?: Record<string, unknown>;
  needs_value_reason?: string;
  escalate_to?: string;
  escalated_at?: string;
  message_template?: string;
  verification?: { status: 'open' | 'confirmed' | 'not_confirmed'; note?: string; by?: string };
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  reason?: string;
  overridden?: boolean;
  issued?: Yiji2MoneyWire;
  wallet_entry_id?: string | number;
  coupon_id?: string | number;
  grant_id?: string | number;
  coupon_code?: string;
  failure?: string;
  created_at?: string;
}

/* ── The CRM's row for a case (collection `compensation_cases`) ────────── */

/**
 * The collection a V2 case is stored in, ONE row per case (keyed by
 * `case_id`), linked to ONE CRM ticket. Design choice 1 (to confirm with the
 * owner): the CRM keeps its own ticket per V2 case - V2 creates no CRM tickets.
 */
export const COMPENSATION_CASES_COLLECTION = 'compensation_cases';

/** The ticket's `external_id` for a case the CRM opened from an event. */
export function compensationCaseTicketKey(caseId: string): string {
  return `compensation-case:${caseId}`;
}

/* ── Idempotency keys that follow the request (review follow-up, 18 Nov) ── */

/** Every value in a fixed key order, so the same request always reads the same. */
export function stableJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
function fnv1a64(text: string, offset: bigint): string {
  let h = offset;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The `Idempotency-Key` of ONE request: derived from a base (the portal's
 * per-form nonce, or the key the portal sent) and the request's material
 * fields (case id, action and the body V2 receives). An identical retry
 * gives the same key, so V2 answers it once; a changed amount, reason,
 * result or category gives a NEW key, so V2 never answers a changed request
 * with the first request's stored result. `crm-` + 32 hex (36 characters,
 * within V2's 128 and the gateway's [A-Za-z0-9_-]{8,100}). Pure and
 * synchronous: the portal and the gateway compute the same value.
 */
export function yiji2RequestKey(base: string, material: unknown): string {
  const text = `${base}\u0000${stableJson(material)}`;
  return `crm-${fnv1a64(text, 0xcbf29ce484222325n)}${fnv1a64(text, 0x84222325cbf29ce4n)}`;
}

/** One agent action on the case, kept on the row (who, what, why, what V2 said). */
export interface CompensationCaseAction {
  action: 'log' | 'approve' | 'reject' | 'evidence' | 'verification' | 'refresh';
  by: string;
  at: string;
  reason?: string;
  amount_minor?: number;
  result?: string;
  outcome: 'ok' | 'refused' | 'unavailable';
  detail?: string;
}

/**
 * FOUR EYES (owner, 18 Nov 2026): the person who LOGGED a case never approves
 * or rejects it - the Administrator excepted. "Logged" is what V2 recorded
 * (`logged_by_agent`, the CRM user id the gateway sent) or a successful `log`
 * in the CRM's own `agent_actions`; either is enough. The AI gateway enforces
 * it (403 `own_case`); the agent portal only hides the two buttons.
 */
export function caseLoggedBy(
  row: Pick<CompensationCaseRow, 'logged_by_agent' | 'agent_actions'>,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (row.logged_by_agent === userId) return true;
  return (row.agent_actions ?? []).some(
    (a) => a?.action === 'log' && a.outcome === 'ok' && a.by === userId,
  );
}

/** The 403 `own_case` refusal, in both portal languages. */
export const OWN_CASE_MESSAGE = {
  en: 'You logged this case, so another person must approve or reject it (a WeCare Supervisor, a WeCare Admin or the Administrator).',
  ar: 'أنت من سجّل هذه الحالة، لذا يجب أن يعتمدها أو يرفضها شخص آخر (مشرف WeCare أو مدير WeCare أو مدير النظام).',
} as const;

/** Every column the workers and the gateway write; all nullable but `case_id`. */
export interface CompensationCaseRow {
  id: string;
  case_id: string;
  vendor: string | null;
  ticket: string | null;
  status: string | null;
  source: string | null;
  trigger_mode: string | null;
  policy_version: number | null;
  row_key: string | null;
  rule_code: string | null;
  counter_group: string | null;
  occurrence: number | null;
  action_type: string | null;
  comp_method: string | null;
  amount_minor: number | null;
  currency: string | null;
  percent_bps: number | null;
  calculation: Record<string, string> | null;
  metric_minutes: number | null;
  stacked: Record<string, unknown> | null;
  needs_value_reason: string | null;
  escalate_to: string | null;
  escalated_at: string | null;
  escalation_condition: string | null;
  escalation_condition_known: boolean | null;
  verification: string | null;
  verification_note: string | null;
  expires_at: string | null;
  has_photos: boolean | null;
  affected_items: unknown[] | null;
  complaint_text: string | null;
  logged_by_agent: string | null;
  order_number: string | null;
  customer_id: string | null;
  country: string | null;
  brand_id: string | null;
  restaurant_id: string | null;
  order_total_minor: number | null;
  order_currency: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  overridden: boolean | null;
  calculated_minor: number | null;
  issued_minor: number | null;
  issued_currency: string | null;
  wallet_entry_id: string | null;
  coupon_id: string | null;
  grant_id: string | null;
  coupon_code: string | null;
  failure: string | null;
  last_event_at: string | null;
  agent_actions: CompensationCaseAction[] | null;
}

/** The columns a reader asks for (the gateway answers these to the portal). */
export const COMPENSATION_CASE_FIELDS: ReadonlyArray<keyof CompensationCaseRow> = [
  'id',
  'case_id',
  'vendor',
  'ticket',
  'status',
  'source',
  'trigger_mode',
  'policy_version',
  'row_key',
  'rule_code',
  'counter_group',
  'occurrence',
  'action_type',
  'comp_method',
  'amount_minor',
  'currency',
  'percent_bps',
  'calculation',
  'metric_minutes',
  'stacked',
  'needs_value_reason',
  'escalate_to',
  'escalated_at',
  'escalation_condition',
  'escalation_condition_known',
  'verification',
  'verification_note',
  'expires_at',
  'has_photos',
  'affected_items',
  'complaint_text',
  'logged_by_agent',
  'order_number',
  'customer_id',
  'country',
  'brand_id',
  'restaurant_id',
  'order_total_minor',
  'order_currency',
  'decided_by',
  'decided_at',
  'decision_reason',
  'overridden',
  'calculated_minor',
  'issued_minor',
  'issued_currency',
  'wallet_entry_id',
  'coupon_id',
  'grant_id',
  'coupon_code',
  'failure',
  'last_event_at',
  'agent_actions',
];

export type CompensationCasePatch = Partial<Omit<CompensationCaseRow, 'id'>>;

const s = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const idOf = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : s(v);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const money = (v: unknown): { minor: number; currency: string } | undefined => {
  const m = rec(v);
  const minor = int(m?.amount_minor);
  const currency = s(m?.currency);
  return minor !== undefined && currency ? { minor, currency } : undefined;
};
const iso = (v: unknown): string | undefined => {
  const x = s(v);
  return x && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : undefined;
};

/** Sets only the keys that carry a value: an absent field never blanks a stored one. */
function put<K extends keyof CompensationCasePatch>(
  out: CompensationCasePatch,
  key: K,
  value: CompensationCasePatch[K] | undefined,
): void {
  if (value !== undefined) out[key] = value;
}

/**
 * A case (the `GET /compensation-cases/{id}` answer, an action's answer, or a
 * `compensation.proposed` payload - they share their field names, except the
 * id: `id` on the API, `case_id` on the event) -> the CRM row's columns.
 */
export function caseFieldsFromWire(w: Record<string, unknown>): CompensationCasePatch {
  const out: CompensationCasePatch = {};
  put(out, 'case_id', idOf(w.case_id) ?? idOf(w.id));
  put(out, 'status', s(w.status));
  put(out, 'source', s(w.source));
  put(out, 'trigger_mode', s(w.trigger_mode));
  put(out, 'policy_version', int(w.policy_version));
  put(out, 'row_key', s(w.row_key));
  put(out, 'rule_code', s(w.rule_code));
  put(out, 'counter_group', s(w.counter_group));
  put(out, 'occurrence', int(w.occurrence));
  put(out, 'action_type', s(w.action_type));
  put(out, 'comp_method', s(w.comp_method));
  const amount = money(w.amount);
  if (amount) {
    out.amount_minor = amount.minor;
    out.currency = amount.currency;
  }
  put(out, 'percent_bps', int(w.percent_bps));
  const calc = rec(w.calculation);
  if (calc)
    out.calculation = Object.fromEntries(
      Object.entries(calc).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    );
  put(out, 'metric_minutes', int(w.metric_minutes));
  put(out, 'stacked', rec(w.stacked));
  put(out, 'needs_value_reason', s(w.needs_value_reason));
  put(out, 'escalate_to', s(w.escalate_to));
  put(out, 'escalated_at', iso(w.escalated_at));
  /* The event says `verification: "open"`; the API an object with `status`. */
  const ver = rec(w.verification);
  put(out, 'verification', s(w.verification) ?? s(ver?.status));
  put(out, 'verification_note', s(ver?.note));
  put(out, 'expires_at', iso(w.expires_at));
  put(out, 'has_photos', bool(w.has_photos));
  if (Array.isArray(w.affected_items)) out.affected_items = w.affected_items.slice(0, 50);
  put(out, 'complaint_text', s(w.text));
  put(out, 'logged_by_agent', s(w.logged_by_agent));
  put(out, 'order_number', idOf(w.order_number));
  put(out, 'customer_id', idOf(w.customer_id));
  put(out, 'country', s(w.country));
  put(out, 'brand_id', idOf(w.brand_id));
  put(out, 'restaurant_id', idOf(w.restaurant_id));
  const total = money(w.order_total);
  if (total) {
    out.order_total_minor = total.minor;
    out.order_currency = total.currency;
  }
  put(out, 'decided_by', s(w.decided_by));
  put(out, 'decided_at', iso(w.decided_at));
  put(out, 'decision_reason', s(w.reason));
  put(out, 'overridden', bool(w.overridden));
  const issued = money(w.issued);
  if (issued) {
    out.issued_minor = issued.minor;
    out.issued_currency = issued.currency;
  }
  put(out, 'wallet_entry_id', idOf(w.wallet_entry_id));
  put(out, 'coupon_id', idOf(w.coupon_id));
  put(out, 'grant_id', idOf(w.grant_id));
  put(out, 'coupon_code', s(w.coupon_code));
  put(out, 'failure', s(w.failure));
  return out;
}

/** `compensation.decided` -> the row's columns. */
export function caseFieldsFromDecided(d: Record<string, unknown>): CompensationCasePatch {
  const out: CompensationCasePatch = {};
  put(out, 'case_id', idOf(d.case_id));
  put(out, 'status', s(d.decision));
  put(out, 'order_number', idOf(d.order_number));
  put(out, 'customer_id', idOf(d.customer_id));
  put(out, 'country', s(d.country));
  put(out, 'row_key', s(d.row_key));
  const by = rec(d.by);
  /* The agent when an agent decided; `system` for an expiry. */
  put(out, 'decided_by', s(d.agent_id) ?? (s(by?.kind) === 'system' ? 'system' : s(by?.id)));
  put(out, 'decided_at', iso(d.at));
  put(out, 'decision_reason', s(d.reason));
  const calculated = money(d.calculated);
  if (calculated) out.calculated_minor = calculated.minor;
  const issued = money(d.issued);
  if (issued) {
    out.issued_minor = issued.minor;
    out.issued_currency = issued.currency;
  }
  put(out, 'percent_bps', int(d.percent_bps));
  put(out, 'overridden', bool(d.overridden));
  put(out, 'wallet_entry_id', idOf(d.wallet_entry_id));
  put(out, 'coupon_id', idOf(d.coupon_id));
  put(out, 'grant_id', idOf(d.grant_id));
  put(out, 'failure', s(d.failure));
  return out;
}

/** `compensation.escalated` -> the row's columns. */
export function caseFieldsFromEscalated(d: Record<string, unknown>): CompensationCasePatch {
  const out: CompensationCasePatch = {};
  put(out, 'case_id', idOf(d.case_id));
  put(out, 'row_key', s(d.row_key));
  put(out, 'rule_code', s(d.rule_code));
  put(out, 'escalate_to', s(d.escalate_to));
  put(out, 'escalated_at', iso(d.at));
  put(out, 'escalation_condition', s(d.condition));
  put(out, 'escalation_condition_known', bool(d.condition_known));
  put(out, 'order_number', idOf(d.order_number));
  put(out, 'customer_id', idOf(d.customer_id));
  put(out, 'country', s(d.country));
  const total = money(d.order_total);
  if (total) {
    out.order_total_minor = total.minor;
    out.order_currency = total.currency;
  }
  return out;
}

/**
 * A decided case never goes back: an event or a read that arrives late (a
 * `compensation.proposed` delivered after its `decided`) keeps the stored
 * terminal status. Every other column is still filled in.
 */
export function mergeCaseStatus(
  stored: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (stored && YIJI2_CASE_TERMINAL_STATUSES.has(stored)) {
    if (incoming && YIJI2_CASE_TERMINAL_STATUSES.has(incoming)) return incoming;
    return stored;
  }
  /* A released case never goes back on hold: V2 moves evidence_hold ->
     proposed (or needs_bhd_value) and never the other way, so a held event
     delivered late (or with the same time, as V2's test clock does) keeps
     the released status. */
  if (incoming === 'evidence_hold' && stored && stored !== 'evidence_hold') return stored;
  return incoming ?? stored ?? null;
}

/** The ticket's Compensation value once a case is decided; null = leave it. */
export function ticketCompensationForCase(
  status: string | null | undefined,
): 'Compensated' | 'Not Compensated' | null {
  if (status === 'approved') return 'Compensated';
  if (status === 'rejected' || status === 'expired' || status === 'failed')
    return 'Not Compensated';
  return null;
}

/* ── The amount override (contract section 3, `/approve`) ──────────────── */

/**
 * Why an override cannot be sent, checked by the gateway BEFORE any call:
 * wallet and amount-coupon cases only (a case with a calculated `amount` and
 * no `percent_bps`, not APOLOGY_ONLY or VERIFY_CCTV), the order's currency,
 * a whole number of minor units above 0, not above the order total. V2
 * checks the same and answers 400; this only keeps a mistyped amount from
 * leaving the CRM. null = fine.
 */
export function yiji2OverrideProblem(
  amountMinor: number,
  c: Pick<
    CompensationCaseRow,
    | 'amount_minor'
    | 'currency'
    | 'percent_bps'
    | 'action_type'
    | 'order_total_minor'
    | 'order_currency'
  >,
):
  | 'not_amount_case'
  | 'not_whole_minor_units'
  | 'not_above_zero'
  | 'above_order_total'
  | 'order_total_unknown'
  | null {
  if (
    c.amount_minor == null ||
    c.percent_bps != null ||
    c.action_type === 'APOLOGY_ONLY' ||
    c.action_type === 'VERIFY_CCTV'
  )
    return 'not_amount_case';
  if (!Number.isInteger(amountMinor)) return 'not_whole_minor_units';
  if (amountMinor <= 0) return 'not_above_zero';
  if (c.order_total_minor == null) return 'order_total_unknown';
  if (amountMinor > c.order_total_minor) return 'above_order_total';
  return null;
}

/** The currency an override is sent in: the order's (V2 refuses any other). */
export function yiji2OverrideCurrency(
  c: Pick<CompensationCaseRow, 'order_currency' | 'currency'>,
): string | null {
  return c.order_currency ?? c.currency ?? null;
}

/** Minor units per major unit: SAR 2 decimals, BHD 3. */
export function caseMinorDigits(currency: string | null | undefined): number {
  return (currency ?? '').toUpperCase() === 'BHD' ? 3 : 2;
}

/** `2500, SAR` -> `SAR 25.00`; never a float in storage, formatting only. */
export function formatCaseMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor == null || !currency) return '—';
  const digits = caseMinorDigits(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const unit = 10 ** digits;
  const major = Math.floor(abs / unit);
  const frac = String(abs % unit).padStart(digits, '0');
  return `${currency.toUpperCase()} ${sign}${major}.${frac}`;
}

/**
 * The amount an agent types (major units, `25.5`) -> minor units, exactly
 * (string arithmetic, no float), or null when it is not a valid amount in
 * that currency (too many decimals, not a number).
 */
export function parseCaseAmount(input: string, currency: string | null | undefined): number | null {
  const digits = caseMinorDigits(currency);
  const t = input.trim();
  const m = /^(\d{1,9})(?:[.,](\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  return Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
}

/** `1500` bps -> `15%`. */
export function formatPercentBps(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const whole = bps / 100;
  return `${Number.isInteger(whole) ? whole : whole.toFixed(2)}%`;
}

/** Time left before `expires_at` (whole minutes, floored); `expired` when none is left. */
export function caseTimeLeft(
  expiresAt: string | null | undefined,
  nowMs: number,
): { expired: boolean; hours: number; minutes: number } | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const left = at - nowMs;
  if (left <= 0) return { expired: true, hours: 0, minutes: 0 };
  const total = Math.floor(left / 60_000);
  return { expired: false, hours: Math.floor(total / 60), minutes: total % 60 };
}

/* ── Events: the workers' job (crm-events-v1.yaml) ─────────────────────── */

export const YIJI2_COMPENSATION_EVENT_TYPES = [
  'compensation.proposed',
  'compensation.decided',
  'compensation.escalated',
] as const;
export type Yiji2CompensationEventType = (typeof YIJI2_COMPENSATION_EVENT_TYPES)[number];

/** The coupons-queue job name for one V2 compensation event. */
export const YIJI2_COMPENSATION_EVENT_JOB = 'yiji2-compensation-event';

export function isYiji2CompensationEvent(type: string): type is Yiji2CompensationEventType {
  return (YIJI2_COMPENSATION_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * A `coupon.granted` WITHOUT `pending_grant_id`: possibly a compensation
 * coupon's grant (its code goes on the case row). One with a pending grant id
 * is the pending-grants path's alone.
 */
export function isYiji2CompensationGrant(e: {
  type: string;
  data?: Record<string, unknown> | null;
}): boolean {
  if (e.type !== 'coupon.granted') return false;
  const p = e.data?.pending_grant_id;
  return p === undefined || p === null || (typeof p === 'string' && p.trim() === '');
}

/** A compensation `coupon.granted` -> the case row's coupon columns. */
export function caseFieldsFromGrant(d: Record<string, unknown>): CompensationCasePatch {
  const out: CompensationCasePatch = {};
  put(out, 'grant_id', idOf(d.grant_id));
  put(out, 'coupon_id', idOf(d.coupon_id));
  put(out, 'coupon_code', s(d.code));
  return out;
}

const idField = z.union([z.string().trim().min(1).max(64), z.number().int()]);
const dt = z.string().datetime({ offset: true });

/** What a job's `data` must hold, per type. The rest is kept as sent. */
const ProposedData = z
  .object({
    case_id: idField,
    status: z.enum(['evidence_hold', 'proposed', 'needs_bhd_value']),
    row_key: z.string().min(1).max(64),
    order_number: idField,
    expires_at: dt,
  })
  .passthrough();
/* `order_number` is optional on a decision: the case is matched by
   `case_id` alone, so a real V2 decision is never refused for lacking it
   (V2's samples of 2026-11-18 do carry it). */
const DecidedData = z
  .object({
    case_id: idField,
    decision: z.enum(YIJI2_CASE_DECISIONS),
    order_number: idField.optional(),
  })
  .passthrough();
const EscalatedData = z
  .object({
    case_id: idField,
    escalate_to: z.string().min(1).max(120),
    order_number: idField,
  })
  .passthrough();

/*
 * A compensation coupon's `coupon.granted` (crm-events-v1.yaml `CouponEvent`):
 * V2 sends it for a coupon case's approval, usually BEFORE
 * `compensation.decided`. It carries no `case_id`; the case is found by
 * `grant_id` (which the decision carries). One WITH `pending_grant_id` is a
 * pending grant assigned at sign-up: that is the coupons job's, never this one.
 */
const GrantedData = z
  .object({
    grant_id: idField,
    coupon_id: idField.optional(),
    code: z.string().trim().min(1).max(128),
  })
  .passthrough();

const jobBase = {
  /** V2's event id (already de-duplicated by the receiver). */
  eventId: z.string().min(1).max(128),
  /** `yiji2:<platform vendor id>`. */
  vendorKey: z.string().min(3),
  /** When V2 says it happened (`occurred_at`). */
  at: dt,
};
export const Yiji2CompensationEventJob = z.discriminatedUnion('type', [
  z.object({ type: z.literal('compensation.proposed'), ...jobBase, data: ProposedData }),
  z.object({ type: z.literal('compensation.decided'), ...jobBase, data: DecidedData }),
  z.object({ type: z.literal('compensation.escalated'), ...jobBase, data: EscalatedData }),
  z.object({ type: z.literal('coupon.granted'), ...jobBase, data: GrantedData }),
]);
export type Yiji2CompensationEventJob = z.infer<typeof Yiji2CompensationEventJob>;

/**
 * One V2 envelope -> the workers' job, or null when it is not a compensation
 * event. A compensation event that lacks what the CRM needs (a case id, its
 * status or decision; the order on a proposal or escalation) is MALFORMED: null, and `opts.malformed` is
 * told - never a case with a guessed field.
 */
export function compensationEventFromYiji2(
  e: Yiji2EventEnvelope,
  vendorKey: string,
  opts: { malformed?: (reason: string, eventId: string) => void } = {},
): Yiji2CompensationEventJob | null {
  if (isYiji2CompensationGrant(e)) {
    /* Not malformed when it does not parse: before this, every grant without
       a pending id was ignored, and a CRM coupon's grant is not ours to judge. */
    const grant = Yiji2CompensationEventJob.safeParse({
      type: e.type,
      eventId: e.id,
      vendorKey,
      at: e.occurred_at,
      data: e.data,
    });
    return grant.success ? grant.data : null;
  }
  if (!isYiji2CompensationEvent(e.type)) return null;
  const parsed = Yiji2CompensationEventJob.safeParse({
    type: e.type,
    eventId: e.id,
    vendorKey,
    at: e.occurred_at,
    data: e.data,
  });
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  opts.malformed?.(
    `${e.type}: ${first ? `${first.path.join('.')} ${first.message}` : 'does not parse'}`,
    e.id,
  );
  return null;
}

/* ── Escalation recipients (design choice 2, to confirm with the owner) ── */

/**
 * The `app_settings` key holding which CRM roles `compensation.escalated`
 * notifies. Its value is JSON: `{ "<escalate_to as V2 sends it>": ["<CRM role
 * name>", ...] }`. Editable by the Administrator (Roles page).
 */
export const COMPENSATION_ESCALATION_SETTING_KEY = 'compensation_escalation_roles';

/** The two roles the owner's policy names (rules.csv `escalate_to`). */
export const COMPENSATION_ESCALATION_TARGETS = [
  'Operations Manager',
  'Relevant management',
] as const;

/**
 * The Administrator (the topmost role, the master user) receives EVERY
 * escalation, whatever the mapping says (owner rule, 18 Nov 2026). Not part
 * of the editable mapping: it cannot be unticked.
 */
export const COMPENSATION_ESCALATION_ALWAYS_ROLE = 'Administrator';

/**
 * The default mapping (owner rule, 18 Nov 2026). The WeCare order is
 * WeCare Agent -> WeCare Supervisor -> WeCare Admin -> Administrator, so V2's
 * "Operations Manager" is the WeCare Supervisor and "Relevant management" the
 * WeCare Admin; the Administrator is added to every escalation on top
 * (`COMPENSATION_ESCALATION_ALWAYS_ROLE`). Resolved by role NAME, never by
 * privilege: the built-in Administrator role carries no privilege list, so
 * resolving by privilege reaches nobody - the "notification recipients trap"
 * (docs/GENERAL-COUPON-ALERT.md).
 */
export const DEFAULT_COMPENSATION_ESCALATION_MAPPING: Readonly<Record<string, readonly string[]>> =
  {
    'Operations Manager': ['WeCare Supervisor'],
    'Relevant management': ['WeCare Admin'],
  };

/**
 * An `escalate_to` the mapping does not know (V2 used a new word): both
 * WeCare manager roles, so an escalation is never dropped. The Administrator
 * is added as for every escalation.
 */
export const DEFAULT_COMPENSATION_ESCALATION_ROLES: readonly string[] = [
  'WeCare Supervisor',
  'WeCare Admin',
];

/**
 * Kept for the worker's log wording: the Administrator is told on every
 * escalation, so the mapped roles having no active member never means nobody.
 */
export const COMPENSATION_ESCALATION_FALLBACK_ROLES: readonly string[] = [
  COMPENSATION_ESCALATION_ALWAYS_ROLE,
];

export type CompensationEscalationRoles = Record<string, string[]>;

export function defaultCompensationEscalationRoles(): CompensationEscalationRoles {
  return Object.fromEntries(
    COMPENSATION_ESCALATION_TARGETS.map((t) => [
      t,
      [...(DEFAULT_COMPENSATION_ESCALATION_MAPPING[t] ?? DEFAULT_COMPENSATION_ESCALATION_ROLES)],
    ]),
  );
}

/**
 * The stored setting -> the mapping. A missing or unreadable value gives the
 * defaults; a target the setting does not name keeps its default. A target
 * mapped to an EMPTY list is kept empty on purpose (the Administrator chose
 * it); the Administrator is still told (always, owner rule 18 Nov 2026).
 */
export function parseCompensationEscalationRoles(raw: unknown): CompensationEscalationRoles {
  const out = defaultCompensationEscalationRoles();
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return out;
    }
  }
  const r = rec(v);
  if (!r) return out;
  for (const [target, roles] of Object.entries(r)) {
    if (!Array.isArray(roles)) continue;
    const names = [
      ...new Set(
        roles.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()),
      ),
    ].slice(0, 20);
    out[target.trim()] = names;
  }
  return out;
}

/** The stored form of a mapping. */
export function compensationEscalationRolesValue(m: CompensationEscalationRoles): string {
  return JSON.stringify(m);
}

/**
 * The role names to notify for one `escalate_to`: the mapped roles plus the
 * Administrator, ALWAYS (owner rule, 18 Nov 2026). Matched without regard to
 * case or spacing; a target the mapping does not know gets both WeCare
 * manager roles (an escalation is never dropped because V2 used a new word).
 */
export function escalationRolesFor(
  m: CompensationEscalationRoles,
  escalateTo: string | null | undefined,
): string[] {
  const want = (escalateTo ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  let mapped: readonly string[] = DEFAULT_COMPENSATION_ESCALATION_ROLES;
  for (const [k, roles] of Object.entries(m))
    if (k.trim().toLowerCase().replace(/\s+/g, ' ') === want) {
      mapped = roles;
      break;
    }
  return [...new Set([...mapped, COMPENSATION_ESCALATION_ALWAYS_ROLE])];
}
