import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@yiji/ui';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * In-chat order retrieval. The agent enters an order id (or leaves it blank to
 * use the customer's latest orders) plus an optional question; the gateway
 * fetches live Yiji commerce data server-side and the model answers grounded in
 * it. Shared by the contact CommercePanel and the inbox ConversationSidebar.
 */

interface Props {
  yijiVendorId: string;
  externalCustomerId: string;
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function fmtAiErr(err: unknown): string {
  const e = err as AiError;
  if (e?.code === 'feature_disabled') return 'Disabled by admin.';
  if (e?.code === 'order_not_found') return 'Order not found.';
  if (e?.code === 'no_orders') return 'No orders for this customer.';
  if (e?.code === 'rate_limited') return 'Rate limited — try again shortly.';
  if (e?.code === 'provider_unavailable' || e?.code === 'upstream')
    return 'AI is temporarily busy. Try again.';
  return e?.message ?? 'Failed.';
}

export function OrderAssistCard({ yijiVendorId, externalCustomerId }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const caller = { userId: user?.id ?? '', vendorId: yijiVendorId };
  const [orderId, setOrderId] = useState('');
  const [question, setQuestion] = useState('');

  const assist = useMutation({
    mutationFn: () =>
      ai.orderAssist(caller, {
        vendorId: yijiVendorId,
        ...(orderId.trim()
          ? { orderId: orderId.trim() }
          : { customerId: externalCustomerId, limit: 4 }),
        ...(question.trim() ? { question: question.trim() } : {}),
      }),
  });

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-4 space-y-3">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('commerce.askAi', { defaultValue: 'Ask AI about orders' })}
      </h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          assist.mutate();
        }}
        className="space-y-2"
      >
        <input
          type="text"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          aria-label={t('commerce.orderIdLabel', { defaultValue: 'Order ID (optional)' })}
          placeholder={t('commerce.orderIdPlaceholder', {
            defaultValue: 'Order ID (blank = latest orders)',
          })}
          className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start"
        />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-label={t('commerce.askPlaceholder', { defaultValue: 'Ask about the order(s)…' })}
            placeholder={t('commerce.askPlaceholder', { defaultValue: 'Ask about the order(s)…' })}
            className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start"
          />
          <Button type="submit" size="sm" loading={assist.isPending}>
            {t('commerce.ask', { defaultValue: 'Ask' })}
          </Button>
        </div>
      </form>

      {assist.data && (
        <div className="rounded-xl bg-secondary/40 px-4 py-3 space-y-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {assist.data.answer}
          </p>
          {assist.data.order && (
            <p className="text-2xs tabular-nums text-muted-foreground">
              {assist.data.order.orderId} · {assist.data.order.status} ·{' '}
              {fmtMoney(assist.data.order.total, assist.data.order.currency)}
            </p>
          )}
          {assist.data.orders && assist.data.orders.length > 0 && (
            <p className="text-2xs tabular-nums text-muted-foreground">
              {assist.data.orders.map((o) => o.orderId).join(', ')}
            </p>
          )}
        </div>
      )}
      {assist.isError && <p className="text-xs text-destructive">{fmtAiErr(assist.error)}</p>}
    </div>
  );
}
