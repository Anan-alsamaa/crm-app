import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, Skeleton } from '@yiji/ui';
import { conversationVendorId, useConversation } from '../inbox/api.js';
import { CreateTicketDialog } from './CreateTicketDialog.js';

/**
 * The "New ticket" page — where clicking an order id in the inbox lands.
 *
 * It is a route rather than a modal because that is how the operations team
 * already works: their tool opens a full New Complaint screen, and the form has
 * three sections they fill in one pass. The cost is that the conversation is no
 * longer on screen, so the order and the customer ride across with the ticket
 * (pinned order in sessionStorage, contact off the conversation) and the header
 * keeps an explicit way back.
 *
 * Only the conversation id travels in the URL. Contact and vendor are read from
 * the conversation itself — passing them as parameters too would let a hand-
 * edited or stale link file a ticket against the wrong customer, and there is
 * nothing in a bare id that would reveal the mismatch.
 */
export function NewTicketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const conversationId = params.get('conversation');

  const conversation = useConversation(conversationId);
  const contactId = conversation.data?.contact?.id ?? null;
  const vendorId = conversationVendorId(conversation.data) || null;

  const backToInbox = () =>
    navigate(conversationId ? `/inbox/${conversationId}` : '/inbox', { replace: true });

  if (conversation.isLoading) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-3 p-6">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-64 w-full rounded-3xl" />
      </div>
    );
  }

  // A ticket needs a customer and a vendor to belong to. Rendering the form
  // without them would let the agent fill in every field and only then fail on
  // save, with the work lost.
  if (!conversationId || !contactId || !vendorId) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          title={t('tickets.newMissingContext', {
            defaultValue: 'This ticket has no conversation behind it',
          })}
          description={t('tickets.newMissingContextHint', {
            defaultValue:
              'Open the chat and use the order id there, so the customer and the order come with it.',
          })}
          action={
            <Button variant="secondary" size="md" onClick={backToInbox}>
              {t('tickets.backToInbox', { defaultValue: 'Back to the inbox' })}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-4 sm:px-6">
        <Button variant="ghost" size="sm" onClick={backToInbox}>
          <span aria-hidden className="me-1.5">
            {/* Logical direction: this arrow points "back", which is right in
                LTR and left in RTL. A hard-coded ← would point forward in Arabic. */}
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
          {t('tickets.backToChat', { defaultValue: 'Back to the chat' })}
        </Button>
      </div>
      <CreateTicketDialog
        chrome="page"
        contactId={contactId}
        vendorId={vendorId}
        conversationId={conversationId}
        onClose={backToInbox}
        // Land on the ticket that was just raised, not back in a chat that has
        // already been dealt with.
        onCreated={(ticketId) => navigate(`/tickets/${ticketId}`, { replace: true })}
      />
    </div>
  );
}
