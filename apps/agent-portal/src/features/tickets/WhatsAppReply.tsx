import { useTranslation } from 'react-i18next';
import { Button, toast } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useStampContacted, type TicketRow } from './api.js';
import { fillWaTemplate, useWaTemplate, waUrl } from './whatsapp.js';

/**
 * One click: WhatsApp opens with the reply drafted, and the ticket records who
 * made the contact. See whatsapp.ts for why the stamp is the point.
 *
 * `window.open` runs INSIDE the click handler, synchronously — deferring it
 * behind an await is how popup blockers decide the tab wasn't user-initiated.
 * The stamp write happens after, fire-and-forget: a failed audit row must not
 * un-open the chat, and a failed chat open writes no stamp.
 */
export function WhatsAppReply({ ticket }: { ticket: TicketRow }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const template = useWaTemplate();
  const stamp = useStampContacted();

  const phone = ticket.contact?.phone ?? null;
  const message = fillWaTemplate(template.data ?? '', {
    order: ticket.order_id ?? ticket.order_snapshot?.orderId?.toString() ?? null,
    name: ticket.contact?.name ?? null,
    brand: ticket.store_snapshot?.brandName ?? ticket.order_snapshot?.brandName ?? null,
    restaurant:
      ticket.store_snapshot?.restaurantName ?? ticket.order_snapshot?.restaurantName ?? null,
  });
  const url = waUrl(phone, message);

  const open = () => {
    if (!url) {
      toast.error(
        t('tickets.waNoNumber', {
          defaultValue: 'No valid Saudi mobile number on this ticket.',
        }),
      );
      return;
    }
    window.open(url, '_blank', 'noopener');
    if (user?.id) {
      stamp.mutate(
        { ticketId: ticket.id, actorId: user.id, phone: phone ?? '' },
        {
          onError: () =>
            // The chat is open either way; the agent needs to know the record
            // of it did not land, because the record is the feature.
            toast.error(
              t('tickets.waStampFailed', {
                defaultValue: 'WhatsApp opened, but recording the contact failed.',
              }),
            ),
        },
      );
    }
    toast.success(t('tickets.waOpening', { defaultValue: 'Opening WhatsApp…' }));
  };

  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="secondary" fullWidth onClick={open}>
        {t('tickets.waReply', { defaultValue: 'WhatsApp the customer' })}
      </Button>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        {t('tickets.waHint', {
          defaultValue: 'Opens the drafted message and records that you made the contact.',
        })}
      </p>
    </div>
  );
}
