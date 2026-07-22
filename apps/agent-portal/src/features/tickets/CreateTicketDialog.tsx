import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Input, Pill, SelectMenu, Textarea, toast } from '@yiji/ui';
import type { Priority, YijiOrder } from '@yiji/shared-types';
import { useConversationAttachmentIds, useCreateTicketFromConversation } from './api.js';
import { useContact } from '../contacts/api.js';
import { commerce } from '../../lib/commerce-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

const schema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});
type FormValues = z.infer<typeof schema>;

interface Props {
  contactId: string;
  vendorId: string;
  conversationId?: string | null;
  onClose: () => void;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `in_delivery` → `In delivery`. */
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Short, locale-aware order date (falls back to the raw ISO string). */
function formatOrderDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Flatten an order into the plain-text block we persist onto the ticket. It is
 * a point-in-time SNAPSHOT (the chat's order context), so it is stored as text
 * rather than re-fetched — the order may change or vanish later.
 * TODO: `deliveryType` isn't exposed by the Yiji order shape yet; add it here
 * once commerce surfaces it.
 */
function orderSnapshotText(order: YijiOrder, label: (key: string, def: string) => string): string {
  const lines: string[] = [];
  lines.push(`${label('tickets.orderSnapshotTitle', 'Order from this chat')}:`);
  lines.push(`#${order.orderId} · ${titleize(order.status)}`);
  if (order.restaurantName)
    lines.push(`${label('tickets.orderRestaurant', 'Restaurant')}: ${order.restaurantName}`);
  if (order.deliveryAddress)
    lines.push(`${label('commerce.deliverTo', 'Deliver to')}: ${order.deliveryAddress}`);
  lines.push(`${label('commerce.total', 'Total')}: ${money(order.total, order.currency)}`);
  if (order.items.length > 0) {
    lines.push(`${label('tickets.orderItems', 'Items')}:`);
    for (const it of order.items) lines.push(`  ${it.qty}× ${it.name}`);
  }
  return lines.join('\n');
}

/** Small labelled checkbox row used to opt the chat context in/out. */
function IncludeToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] ring-1 transition-colors duration-fast ease-out',
          checked
            ? 'bg-primary text-primary-foreground ring-primary'
            : 'bg-card text-transparent ring-foreground/20',
        )}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3" aria-hidden>
          <path d="m3 8 3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 text-xs leading-relaxed text-foreground">{children}</span>
    </label>
  );
}

export function CreateTicketDialog({ contactId, vendorId, conversationId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const createFromChat = useCreateTicketFromConversation();
  const { user } = useAuth();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { priority: 'medium' },
  });

  // Chat context (#3): the order shown in this chat + the files shared in it.
  // Both are best-effort — a chat with no linked Yiji customer or no attachments
  // simply hides that row; ticket creation never depends on either resolving.
  const contact = useContact(contactId);
  const yijiVendorId = contact.data?.vendor?.yiji_vendor_id ?? '';
  const externalCustomerId = contact.data?.external_customer_id ?? '';
  const ordersQuery = useQuery({
    queryKey: ['yiji-orders', yijiVendorId, externalCustomerId, 1],
    enabled: !!conversationId && !!yijiVendorId && !!externalCustomerId,
    queryFn: () => commerce.getOrders(yijiVendorId, externalCustomerId, { limit: 1 }),
    staleTime: 60_000,
  });
  const latestOrder = ordersQuery.data?.[0] ?? null;
  const sessionFiles = useConversationAttachmentIds(conversationId ?? null);
  const sessionFileIds = sessionFiles.data ?? [];

  const [includeOrder, setIncludeOrder] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      // Compose the description: the agent's own text first, then the order
      // snapshot (if kept). Filter empties so we never store dangling blank lines.
      const parts = [values.description?.trim() ?? ''];
      if (includeOrder && latestOrder)
        parts.push(orderSnapshotText(latestOrder, (k, d) => t(k, { defaultValue: d })));
      const description = parts.filter(Boolean).join('\n\n') || undefined;

      await createFromChat.mutateAsync({
        ticket: {
          subject: values.subject,
          description,
          priority: values.priority,
          contact: contactId,
          vendor: vendorId,
          conversation: conversationId ?? null,
          assigned_agent: user?.id ?? null,
        },
        attachmentFileIds: includeFiles ? sessionFileIds : [],
      });
      toast.success(t('tickets.created', { defaultValue: 'Ticket created' }), {
        description: values.subject,
      });
      onClose();
    } catch {
      toast.error(t('tickets.createError'));
    }
  });

  const hasChatContext = !!conversationId && (!!latestOrder || sessionFileIds.length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-3xl bg-card p-7 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in">
        <div className="mb-6 space-y-1.5">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
            {t('tickets.createTitle')}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('tickets.createHint', {
              defaultValue: 'Capture the work as a ticket so it can be tracked against an SLA.',
            })}
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormField
            label={t('tickets.subject')}
            htmlFor="ticket-subject"
            error={errors.subject?.message}
          >
            <Input id="ticket-subject" invalid={!!errors.subject} {...register('subject')} />
          </FormField>
          <FormField label={t('tickets.description')} htmlFor="ticket-description">
            <Textarea id="ticket-description" rows={3} {...register('description')} />
          </FormField>
          <FormField label={t('conversation.priority')} htmlFor="ticket-priority">
            <Controller
              control={control}
              name="priority"
              render={({ field }) => (
                <SelectMenu
                  fullWidth
                  value={field.value}
                  onChange={field.onChange}
                  aria-label={t('conversation.priority')}
                  options={PRIORITIES.map((p) => ({
                    value: p,
                    label: t(`priority.${p}`, { ns: 'common' }),
                  }))}
                />
              )}
            />
          </FormField>

          {/* From-this-chat context (#3): the order + files shared in this
              session, carried onto the ticket. Only shown when the chat has
              something to carry over. */}
          {hasChatContext && (
            <div className="space-y-3 rounded-2xl bg-secondary/50 p-3.5 ring-1 ring-foreground/[0.05]">
              <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('tickets.fromChat', { defaultValue: 'From this chat' })}
              </div>
              {latestOrder && (
                <IncludeToggle checked={includeOrder} onChange={setIncludeOrder}>
                  <span className="font-medium">
                    {t('tickets.includeOrder', { defaultValue: 'Attach order details' })}
                  </span>
                  {/* Surface exactly which order is being snapshotted. This is the
                      customer's LATEST order, which may be unrelated to this chat
                      (the conversation schema carries no order reference), so the
                      agent must be able to see the id, date and restaurant before
                      attaching it rather than opting in blindly. */}
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <span className="font-mono">#{latestOrder.orderId}</span>
                    <Pill tone="neutral" size="sm">
                      {titleize(latestOrder.status)}
                    </Pill>
                    <span className="tabular-nums">
                      {money(latestOrder.total, latestOrder.currency)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <span className="tabular-nums">
                      {formatOrderDate(latestOrder.placedAt, i18n.language)}
                    </span>
                    {latestOrder.restaurantName && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="min-w-0 truncate">{latestOrder.restaurantName}</span>
                      </>
                    )}
                  </span>
                </IncludeToggle>
              )}
              {sessionFileIds.length > 0 && (
                <IncludeToggle checked={includeFiles} onChange={setIncludeFiles}>
                  <span className="font-medium">
                    {t('tickets.includeAttachments', {
                      defaultValue: 'Attach files shared in this chat',
                    })}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    {t('tickets.includeAttachmentsCount', {
                      defaultValue: '{{count}} file(s) from this session',
                      count: sessionFileIds.length,
                    })}
                  </span>
                </IncludeToggle>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" size="md" loading={isSubmitting || createFromChat.isPending}>
              {t('tickets.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
