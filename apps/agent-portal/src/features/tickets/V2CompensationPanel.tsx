import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn, FormField, Input, Pill, Select, Textarea, toast, useNow } from '@yiji/ui';
import {
  YIJI2_AGENT_COMPLAINT_CODES,
  YIJI2_CASE_TERMINAL_STATUSES,
  caseTimeLeft,
  formatCaseMoney,
  formatPercentBps,
  parseCaseAmount,
  yiji2CaseConflictMessage,
  yiji2OverrideCurrency,
  yiji2OverrideProblem,
  type CompensationCaseRow,
  type Yiji2AgentComplaintCode,
} from '@yiji/shared-types';
import {
  CaseActionError,
  compensationCases,
  newIdempotencyKey,
  requestKey,
  type CaseAction,
  type TicketCases,
} from '../../lib/compensation-cases-client.js';

/**
 * YIJI V2 COMPENSATION ON THE TICKET (owner, 18 Nov 2026).
 *
 * V2 computes each case from the owner's policy; EVERY case needs one
 * approval by a CRM agent; V2 then issues and messages the customer. A case
 * expires 72 hours after it was proposed. This panel shows a case the way the
 * contract's section 2 lists it and carries the four actions (Approve with an
 * optional amount, Reject, Photos received, Camera check done), each with a
 * reason, for whoever holds `approve_compensation_cases`. From a v2 ticket
 * with an order, the same people may "Log V2 complaint".
 *
 * RENDERS NOTHING for a ticket that is not a Yiji v2 ticket (every v1 ticket),
 * or when the gateway cannot be asked - a v1 ticket looks exactly as before.
 */

export const V2_CASES_QUERY = 'v2-compensation-cases';

type Tone = 'neutral' | 'primary' | 'success' | 'highlight' | 'warning' | 'destructive' | 'muted';

const STATUS_TONE: Record<string, Tone> = {
  proposed: 'highlight',
  evidence_hold: 'warning',
  needs_bhd_value: 'warning',
  approved: 'success',
  rejected: 'muted',
  expired: 'muted',
  failed: 'destructive',
};

function useStatusLabel() {
  const { t } = useTranslation();
  return (s: string | null | undefined): string => {
    switch (s) {
      case 'proposed':
        return t('v2Case.status.proposed', { defaultValue: 'Waiting for approval' });
      case 'evidence_hold':
        return t('v2Case.status.evidenceHold', { defaultValue: 'Waiting for photos' });
      case 'needs_bhd_value':
        return t('v2Case.status.needsBhdValue', { defaultValue: 'No BHD value' });
      case 'approved':
        return t('v2Case.status.approved', { defaultValue: 'Approved' });
      case 'rejected':
        return t('v2Case.status.rejected', { defaultValue: 'Rejected' });
      case 'expired':
        return t('v2Case.status.expired', { defaultValue: 'Expired' });
      case 'failed':
        return t('v2Case.status.failed', { defaultValue: 'Failed' });
      default:
        return s ?? '—';
    }
  };
}

/** The 409 reason in the agent's language, else the gateway's words. */
function useRefusalText() {
  const { t } = useTranslation();
  return (err: unknown): string => {
    if (!(err instanceof CaseActionError))
      return t('v2Case.error.generic', { defaultValue: 'That did not go through. Try again.' });
    if (err.status === 409 && err.reason) {
      const en = yiji2CaseConflictMessage(err.reason);
      switch (err.reason) {
        case 'closed':
          return t('v2Case.conflict.closed', { defaultValue: en });
        case 'expired':
          return t('v2Case.conflict.expired', { defaultValue: en });
        case 'evidence_hold':
          return t('v2Case.conflict.evidenceHold', { defaultValue: en });
        case 'needs_bhd_value':
          return t('v2Case.conflict.needsBhdValue', { defaultValue: en });
        case 'failed':
          return t('v2Case.conflict.failed', { defaultValue: en });
        case 'not_held':
          return t('v2Case.conflict.notHeld', { defaultValue: en });
        case 'no_verification':
          return t('v2Case.conflict.noVerification', { defaultValue: en });
        default:
          return en;
      }
    }
    if (err.code === 'case_on_other_ticket')
      return err.ticketId
        ? t('v2Case.error.otherTicket', {
            defaultValue:
              'This order already has a case of that category on ticket {{ticket}}. Act on it from that ticket.',
            ticket: err.ticketId,
          })
        : t('v2Case.error.otherTicketHidden', {
            defaultValue:
              'This order already has a case of that category on another ticket, which you cannot open. Ask a supervisor.',
          });
    if (err.code === 'invalid_amount')
      return t('v2Case.error.amount', {
        defaultValue:
          'That amount cannot be sent: above zero, in the order’s currency, and not above the order total.',
      });
    if (err.code === 'approve_compensation_cases_required')
      return t('v2Case.error.forbidden', {
        defaultValue: 'You do not have the permission to act on V2 compensation cases.',
      });
    if (err.code === 'v2_unavailable')
      return t('v2Case.error.unavailable', {
        defaultValue: 'Yiji V2 is not answering. Nothing was changed; try again shortly.',
      });
    if (err.code === 'unknown_vendor')
      return t('v2Case.error.inactive', {
        defaultValue: 'Yiji V2 is not active in the CRM, so nothing can be sent.',
      });
    if (err.code === 'refused')
      return t('v2Case.error.refused', {
        defaultValue: 'Yiji V2 refused it: {{detail}}',
        detail: err.detail ?? err.code,
      });
    return t('v2Case.error.generic', { defaultValue: 'That did not go through. Try again.' });
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function Countdown({ expiresAt, status }: { expiresAt: string | null; status: string | null }) {
  const { t } = useTranslation();
  const now = useNow(30_000);
  if (status && YIJI2_CASE_TERMINAL_STATUSES.has(status)) return null;
  const left = caseTimeLeft(expiresAt, now);
  if (!left) return null;
  if (left.expired)
    return (
      <Pill tone="destructive" size="sm">
        {t('v2Case.expiresPassed', { defaultValue: '72 hours passed' })}
      </Pill>
    );
  return (
    <Pill tone={left.hours < 6 ? 'warning' : 'neutral'} size="sm" dot>
      {t('v2Case.expiresIn', {
        defaultValue: '{{hours}} h {{minutes}} min left',
        hours: left.hours,
        minutes: left.minutes,
      })}
    </Pill>
  );
}

/** What each action may be offered for, from the case's status. */
export function actionsFor(c: Pick<CompensationCaseRow, 'status' | 'verification'>): CaseAction[] {
  const s = c.status ?? '';
  if (YIJI2_CASE_TERMINAL_STATUSES.has(s)) return c.verification === 'open' ? ['verification'] : [];
  const out: CaseAction[] = [];
  if (s === 'proposed') out.push('approve');
  if (s === 'evidence_hold') out.push('evidence');
  out.push('reject');
  if (c.verification === 'open') out.push('verification');
  return out;
}

function ActionForm({
  c,
  ticketId,
  action,
  onDone,
  onCancel,
}: {
  c: CompensationCaseRow;
  ticketId: string;
  action: CaseAction;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusalText();
  /* One nonce per opened form; the key also follows the body, so an identical
     retry never acts twice and a changed one is a new request to V2. */
  const [nonce] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<'confirmed' | 'not_confirmed'>('confirmed');
  const [error, setError] = useState<string | null>(null);
  const currency = yiji2OverrideCurrency(c);
  const overridable = action === 'approve' && yiji2OverrideProblem(1, c) !== 'not_amount_case';
  const amountMinor = amount.trim() ? parseCaseAmount(amount, currency) : undefined;
  const amountProblem =
    amount.trim() === ''
      ? null
      : amountMinor == null
        ? 'not_whole_minor_units'
        : yiji2OverrideProblem(amountMinor, c);

  const run = useMutation({
    mutationFn: () => {
      const body = {
        ticketId,
        reason: reason.trim(),
        ...(action === 'approve' && amountMinor != null ? { amountMinor } : {}),
        ...(action === 'verification' ? { result } : {}),
      };
      return compensationCases.act(c.case_id, action, {
        ...body,
        idempotencyKey: requestKey(nonce, c.case_id, action, body),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [V2_CASES_QUERY, ticketId] });
      toast.success(t('v2Case.done', { defaultValue: 'Sent to Yiji V2.' }));
      onDone();
    },
    onError: (err) => {
      setError(refusal(err));
      if (err instanceof CaseActionError && err.fresh)
        void qc.invalidateQueries({ queryKey: [V2_CASES_QUERY, ticketId] });
    },
  });

  const title =
    action === 'approve'
      ? t('v2Case.action.approve', { defaultValue: 'Approve' })
      : action === 'reject'
        ? t('v2Case.action.reject', { defaultValue: 'Reject' })
        : action === 'evidence'
          ? t('v2Case.action.evidence', { defaultValue: 'Photos received' })
          : t('v2Case.action.verification', { defaultValue: 'Camera check done' });
  const disabled =
    !reason.trim() || run.isPending || (action === 'approve' && amountProblem !== null);

  return (
    <form
      className="space-y-3 rounded-2xl bg-foreground/[0.04] p-3.5 ring-1 ring-inset ring-foreground/[0.06]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) {
          setError(null);
          run.mutate();
        }
      }}
    >
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {action === 'approve' && (
        <p className="text-xs text-muted-foreground">
          {t('v2Case.approveHint', {
            defaultValue:
              'Yiji V2 issues the compensation and sends the customer its message as soon as you approve.',
          })}
        </p>
      )}
      {action === 'evidence' && (
        <p className="text-xs text-muted-foreground">
          {t('v2Case.evidenceHint', {
            defaultValue:
              'Confirm only after you checked the photos yourself. V2 then calculates the case and starts a new 72 hours.',
          })}
        </p>
      )}
      {overridable && (
        <FormField
          label={t('v2Case.amountOverride', {
            defaultValue: 'Different amount ({{currency}}, optional)',
            currency: currency ?? '',
          })}
          hint={t('v2Case.amountOverrideHint', {
            defaultValue:
              'Leave empty to approve {{amount}}. Not above the order total ({{total}}).',
            amount: formatCaseMoney(c.amount_minor, c.currency),
            total: formatCaseMoney(c.order_total_minor, c.order_currency),
          })}
          error={
            amountProblem
              ? t('v2Case.error.amount', {
                  defaultValue:
                    'That amount cannot be sent: above zero, in the order’s currency, and not above the order total.',
                })
              : undefined
          }
        >
          <Input
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </FormField>
      )}
      {action === 'verification' && (
        <FormField
          label={t('v2Case.verificationResult', { defaultValue: 'What the cameras show' })}
        >
          <Select
            value={result}
            onChange={(e) => setResult(e.target.value as 'confirmed' | 'not_confirmed')}
          >
            <option value="confirmed">
              {t('v2Case.verification.confirmed', { defaultValue: 'Confirmed' })}
            </option>
            <option value="not_confirmed">
              {t('v2Case.verification.notConfirmed', { defaultValue: 'Not confirmed' })}
            </option>
          </Select>
        </FormField>
      )}
      <FormField label={t('v2Case.reason', { defaultValue: 'Reason (required)' })}>
        <Textarea
          rows={2}
          dir="auto"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </FormField>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive-tint/70 px-3 py-2 text-xs leading-relaxed text-foreground"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant={action === 'reject' ? 'destructive-soft' : 'default'}
          disabled={disabled}
        >
          {title}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('v2Case.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </form>
  );
}

function CaseCard({
  c,
  ticketId,
  canAct,
}: {
  c: CompensationCaseRow;
  ticketId: string;
  canAct: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const statusLabel = useStatusLabel();
  const [open, setOpen] = useState<CaseAction | null>(null);
  const actions = canAct ? actionsFor(c) : [];
  const amount =
    c.amount_minor != null
      ? formatCaseMoney(c.amount_minor, c.currency)
      : c.percent_bps != null
        ? formatPercentBps(c.percent_bps)
        : '—';
  const calc = Object.entries(c.calculation ?? {});
  const items = (c.affected_items ?? []) as Array<Record<string, unknown>>;
  const label = (a: CaseAction) =>
    a === 'approve'
      ? t('v2Case.action.approve', { defaultValue: 'Approve' })
      : a === 'reject'
        ? t('v2Case.action.reject', { defaultValue: 'Reject' })
        : a === 'evidence'
          ? t('v2Case.action.evidence', { defaultValue: 'Photos received' })
          : t('v2Case.action.verification', { defaultValue: 'Camera check done' });

  return (
    <article
      data-testid="v2-case"
      className="space-y-3 rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[c.status ?? ''] ?? 'neutral'} size="sm">
          {statusLabel(c.status)}
        </Pill>
        <span className="text-sm font-semibold text-foreground">
          {t('v2Case.caseTitle', {
            defaultValue: 'Case #{{id}}',
            id: c.case_id,
          })}
        </span>
        <Countdown expiresAt={c.expires_at} status={c.status} />
      </header>

      {c.escalate_to && (
        <p
          role="status"
          className="rounded-xl bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground"
        >
          {t('v2Case.escalated', {
            defaultValue: 'Escalated: {{role}} was notified{{condition}}.',
            role: c.escalate_to,
            condition: c.escalation_condition ? ` (${c.escalation_condition})` : '',
          })}
        </p>
      )}
      {c.status === 'needs_bhd_value' && (
        <p className="rounded-xl bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground">
          {t('v2Case.needsBhdValue', {
            defaultValue:
              'No Bahraini dinar value for this rule yet ({{reason}}). It can only be rejected.',
            reason: c.needs_value_reason ?? '—',
          })}
        </p>
      )}
      {c.status === 'evidence_hold' && c.has_photos && (
        <p className="rounded-xl bg-foreground/[0.04] px-3 py-2 text-xs leading-relaxed text-foreground">
          {t('v2Case.photosSaid', {
            defaultValue:
              'The app says the customer sent photos. Check them, then use “Photos received”. The app’s flag alone never releases a case.',
          })}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Field label={t('v2Case.rule', { defaultValue: 'Rule' })}>
          {c.rule_code ?? '—'}
          {c.occurrence
            ? ` · ${t('v2Case.occurrence', { defaultValue: 'time {{n}}', n: c.occurrence })}`
            : ''}
          {c.row_key ? ` (${c.row_key})` : ''}
        </Field>
        <Field label={t('v2Case.actionType', { defaultValue: 'What approval issues' })}>
          {c.action_type ?? '—'}
          {c.comp_method ? ` · ${c.comp_method}` : ''}
        </Field>
        <Field label={t('v2Case.amount', { defaultValue: 'Amount' })}>
          <span dir="ltr">{amount}</span>
        </Field>
        {c.metric_minutes != null && (
          <Field label={t('v2Case.metricMinutes', { defaultValue: 'Minutes late' })}>
            {c.metric_minutes}
          </Field>
        )}
        {c.verification && (
          <Field label={t('v2Case.verificationLabel', { defaultValue: 'Camera check' })}>
            {c.verification === 'open'
              ? t('v2Case.verification.open', { defaultValue: 'Open' })
              : c.verification === 'confirmed'
                ? t('v2Case.verification.confirmed', { defaultValue: 'Confirmed' })
                : t('v2Case.verification.notConfirmed', { defaultValue: 'Not confirmed' })}
          </Field>
        )}
        <Field label={t('v2Case.photos', { defaultValue: 'Photos' })}>
          {c.has_photos
            ? t('v2Case.yes', { defaultValue: 'Yes' })
            : t('v2Case.no', { defaultValue: 'No' })}
        </Field>
        <Field label={t('v2Case.order', { defaultValue: 'Order' })}>
          <span dir="ltr">
            {c.order_number ?? '—'}
            {c.order_total_minor != null
              ? ` · ${formatCaseMoney(c.order_total_minor, c.order_currency)}`
              : ''}
          </span>
        </Field>
      </dl>

      {calc.length > 0 && (
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('v2Case.calculation', { defaultValue: 'How the amount was reached (minor units)' })}
          </p>
          <ul dir="ltr" className="mt-1 space-y-0.5 font-mono text-xs text-foreground/85">
            {calc.map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.stacked && (
        <p className="text-xs text-muted-foreground">
          {t('v2Case.stacked', {
            defaultValue: 'Left out because it paid less: {{detail}}',
            detail: JSON.stringify(c.stacked),
          })}
        </p>
      )}
      {items.length > 0 && (
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('v2Case.items', { defaultValue: 'Affected items' })}
          </p>
          <ul dir="ltr" className="mt-1 space-y-0.5 text-xs text-foreground/85">
            {items.map((i, n) => (
              <li key={n}>
                #{String(i.order_item_id ?? '?')} × {String(i.quantity ?? '?')}
                {typeof i.unit_price_minor === 'number'
                  ? ` · ${formatCaseMoney(i.unit_price_minor, c.order_currency)}`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.complaint_text && (
        <p
          dir="auto"
          className="whitespace-pre-wrap rounded-xl bg-foreground/[0.035] px-3 py-2 text-sm"
        >
          {c.complaint_text}
        </p>
      )}

      {c.status && YIJI2_CASE_TERMINAL_STATUSES.has(c.status) && (
        <p className="text-xs text-muted-foreground">
          {t('v2Case.decided', {
            defaultValue: '{{status}} by {{by}}. {{issued}}{{reason}}',
            status: statusLabel(c.status),
            by: c.decided_by ?? '—',
            issued:
              c.issued_minor != null
                ? `${formatCaseMoney(c.issued_minor, c.issued_currency)}${c.overridden ? t('v2Case.overridden', { defaultValue: ' (amount changed by the agent)' }) : ''}. `
                : '',
            reason: c.decision_reason ?? c.failure ?? '',
          })}
        </p>
      )}

      {actions.length > 0 && !open && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a}
              type="button"
              size="sm"
              variant={
                a === 'approve' ? 'default' : a === 'reject' ? 'destructive-soft' : 'outline'
              }
              onClick={() => setOpen(a)}
            >
              {label(a)}
            </Button>
          ))}
        </div>
      )}
      {open && (
        <ActionForm
          c={c}
          ticketId={ticketId}
          action={open}
          onDone={() => setOpen(null)}
          onCancel={() => setOpen(null)}
        />
      )}
    </article>
  );
}

function LogComplaintForm({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusalText();
  const [nonce] = useState(newIdempotencyKey);
  const [category, setCategory] = useState<Yiji2AgentComplaintCode | ''>('');
  const [hasPhotos, setHasPhotos] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      const body = {
        ticketId,
        category: category as Yiji2AgentComplaintCode,
        hasPhotos,
        ...(text.trim() ? { text: text.trim() } : {}),
      };
      return compensationCases.logComplaint({
        ...body,
        idempotencyKey: requestKey(nonce, null, 'log', body),
      });
    },
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: [V2_CASES_QUERY, ticketId] });
      toast.success(
        out.onThisTicket
          ? t('v2Case.logged', { defaultValue: 'Complaint logged. Yiji V2 proposed a case.' })
          : t('v2Case.loggedElsewhere', {
              defaultValue: 'This order already has a case of that category on another ticket.',
            }),
      );
      onClose();
    },
    onError: (err) => setError(refusal(err)),
  });
  return (
    <form
      className="space-y-3 rounded-2xl bg-foreground/[0.04] p-3.5 ring-1 ring-inset ring-foreground/[0.06]"
      onSubmit={(e) => {
        e.preventDefault();
        if (category && !run.isPending) {
          setError(null);
          run.mutate();
        }
      }}
    >
      <FormField label={t('v2Case.category', { defaultValue: 'Complaint (policy code)' })}>
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as Yiji2AgentComplaintCode)}
        >
          <option value="">{t('v2Case.pickCategory', { defaultValue: 'Choose…' })}</option>
          {YIJI2_AGENT_COMPLAINT_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </FormField>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={hasPhotos}
          onChange={(e) => setHasPhotos(e.target.checked)}
        />
        {t('v2Case.hasPhotos', { defaultValue: 'The customer sent photos' })}
      </label>
      <FormField label={t('v2Case.text', { defaultValue: 'What the customer said' })}>
        <Textarea
          rows={3}
          dir="auto"
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </FormField>
      <p className="text-xs text-muted-foreground">
        {t('v2Case.itemsLater', {
          defaultValue:
            'Item prices come from the order. Picking the affected items follows when V2 sends order line ids.',
        })}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive-tint/70 px-3 py-2 text-xs leading-relaxed text-foreground"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!category || run.isPending}>
          {t('v2Case.logSubmit', { defaultValue: 'Send to Yiji V2' })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('v2Case.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </form>
  );
}

export function useTicketV2Cases(ticketId: string) {
  return useQuery<TicketCases | null>({
    queryKey: [V2_CASES_QUERY, ticketId],
    enabled: !!ticketId,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        return await compensationCases.forTicket(ticketId);
      } catch {
        /* Not reachable, not allowed, or an old gateway: show nothing. */
        return null;
      }
    },
  });
}

export function V2CompensationPanel({
  ticketId,
  className,
}: {
  ticketId: string;
  className?: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const q = useTicketV2Cases(ticketId);
  const [logging, setLogging] = useState(false);
  const data = q.data;
  const sorted = useMemo(
    () =>
      [...(data?.cases ?? [])].sort(
        (a, b) =>
          Number(YIJI2_CASE_TERMINAL_STATUSES.has(a.status ?? '')) -
          Number(YIJI2_CASE_TERMINAL_STATUSES.has(b.status ?? '')),
      ),
    [data],
  );
  if (!data || !data.v2) return null;
  const canLog = data.canAct && !!data.orderNumber;
  if (sorted.length === 0 && !canLog) return null;

  return (
    <section
      data-testid="v2-compensation-panel"
      aria-labelledby="v2-compensation-title"
      className={cn('space-y-3', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="v2-compensation-title"
          className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t('v2Case.title', { defaultValue: 'Yiji V2 compensation' })}
        </h3>
        {canLog && !logging && (
          <Button type="button" size="sm" variant="outline" onClick={() => setLogging(true)}>
            {t('v2Case.log', { defaultValue: 'Log V2 complaint' })}
          </Button>
        )}
      </div>
      {logging && <LogComplaintForm ticketId={ticketId} onClose={() => setLogging(false)} />}
      {sorted.map((c) => (
        <CaseCard key={c.case_id} c={c} ticketId={ticketId} canAct={data.canAct} />
      ))}
    </section>
  );
}
