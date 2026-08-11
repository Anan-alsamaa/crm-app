import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Skeleton } from '@yiji/ui';
import { conversationVendorId, useConversation } from '../inbox/api.js';
import type { ContactRow } from '../contacts/api.js';
import { ContactPicker } from './ContactPicker.js';
import { CreateTicketDialog } from './CreateTicketDialog.js';

/**
 * "Add ticket" — the one place a ticket is raised, in either of its two shapes.
 *
 * FROM A CHAT (`?conversation=…`, reached by clicking the order id in the
 * inbox): the customer, the order and the branch come with it, so most of the
 * form is already answered.
 *
 * STANDALONE (reached from the top nav): a complaint that arrived by phone or
 * social with no chat behind it, so the agent searches for the customer first.
 *
 * Only the conversation id travels in the URL. Contact and vendor are read from
 * the conversation itself — passing them as parameters too would let a hand-
 * edited or stale link file a ticket against the wrong customer, and a bare id
 * gives nothing that would reveal the mismatch.
 */
export function NewTicketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const conversationId = params.get('conversation');

  const conversation = useConversation(conversationId);
  const [picked, setPicked] = useState<ContactRow | null>(null);

  // From a chat the customer is settled; standalone, the agent picks one. A
  // contact with no vendor cannot carry a ticket, so it does not count as
  // chosen — submit stays disabled rather than failing on save.
  const fromChat = !!conversationId;
  const contactId = fromChat ? (conversation.data?.contact?.id ?? null) : (picked?.id ?? null);
  const vendorId = fromChat
    ? conversationVendorId(conversation.data) || null
    : (picked?.vendor?.id ?? null);

  const goBack = () =>
    navigate(conversationId ? `/inbox/${conversationId}` : '/tickets', { replace: true });

  if (fromChat && conversation.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="min-h-0 flex-1 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-3 sm:px-6">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <span aria-hidden className="me-1.5">
            {/* Mirrored in RTL: a hard-coded ← points forward in Arabic. */}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5 rtl:-scale-x-100"
            >
              <path d="M10 3 5 8l5 5" />
            </svg>
          </span>
          {fromChat
            ? t('tickets.backToChat', { defaultValue: 'Back to the chat' })
            : t('tickets.backToTickets', { defaultValue: 'Back to tickets' })}
        </Button>
      </div>
      <CreateTicketDialog
        contactId={contactId}
        vendorId={vendorId}
        conversationId={conversationId}
        onClose={goBack}
        // Standalone only: from a chat the customer is not a choice, and
        // offering to change it would invite filing against the wrong one.
        contactField={fromChat ? undefined : <ContactPicker value={picked} onChange={setPicked} />}
        // Land on the ticket just raised, not back where it was started.
        onCreated={(ticketId) => navigate(`/tickets/${ticketId}`, { replace: true })}
      />
    </div>
  );
}
