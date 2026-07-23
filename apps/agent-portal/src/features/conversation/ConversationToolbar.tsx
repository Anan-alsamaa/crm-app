import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, Avatar, Button, cn, GhostSelect, InfoIcon, toast } from '@yiji/ui';
import { SOCKET_EVENTS, type ConversationStatus, type Priority } from '@yiji/shared-types';
import {
  useAgents,
  useLinkedTickets,
  useTeamOptions,
  useUpdateConversation,
  type InboxConversation,
} from '../inbox/api.js';
import { getSocket } from '../../lib/socket.js';
import { CreateTicketDialog } from '../tickets/CreateTicketDialog.js';

const STATUSES: ConversationStatus[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

async function broadcastUpdate(conversationId: string): Promise<void> {
  const socket = await getSocket();
  socket.emit(SOCKET_EVENTS.conversationUpdated, { conversationId });
}

interface Props {
  conversation: InboxConversation;
  /** Live customer presence for this conversation (gateway `customer:presence`).
   *  null until the first event — then drives the "{name} is online" /
   *  "New customer" header line. */
  customerPresence?: { online: boolean; isNew: boolean } | null;
  /** Mobile-only: return to the inbox list (single-column view). */
  onBack?: () => void;
  /** Mobile-only: open the conversation details/notes panel. */
  onToggleDetails?: () => void;
}

export function ConversationToolbar({
  conversation,
  customerPresence,
  onBack,
  onToggleDetails,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const agents = useAgents();
  const teams = useTeamOptions();
  const update = useUpdateConversation();
  const linkedTickets = useLinkedTickets(conversation.id);
  const [openTicketDialog, setOpenTicketDialog] = useState(false);
  // #6: once a chat is closed/resolved, nudge the agent to turn it into a ticket
  // so no conversation is left without a follow-up record. Dismissible, and reset
  // per conversation so a dismissal doesn't leak across threads.
  const [promptDismissed, setPromptDismissed] = useState(false);
  useEffect(() => setPromptDismissed(false), [conversation.id]);

  const vendorId =
    (conversation as unknown as { vendor?: { id?: string } | string }).vendor &&
    typeof (conversation as unknown as { vendor?: { id?: string } | string }).vendor === 'object'
      ? (conversation as unknown as { vendor: { id: string } }).vendor.id
      : ((conversation as unknown as { vendor?: string }).vendor ?? '');

  const patch = async (p: Parameters<typeof update.mutateAsync>[0]['patch']) => {
    try {
      await update.mutateAsync({ id: conversation.id, patch: p });
      await broadcastUpdate(conversation.id);
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  const contact = conversation.contact;
  // A new customer (gateway created the contact on first contact) leads with the
  // phone number — we may not have a name yet — plus a "New customer" tag. A
  // returning customer leads with their name and a live online/offline state.
  // With no live presence (e.g. an old thread opened while the customer is
  // offline) we fall back to the plain stored identity.
  const isNew = customerPresence?.isNew ?? false;
  const primaryLabel = isNew
    ? (contact?.phone ??
      contact?.name ??
      t('conversation.newCustomer', { defaultValue: 'New customer' }))
    : (contact?.name ??
      contact?.phone ??
      contact?.email ??
      t('inbox.unknownContact', { defaultValue: 'Customer' }));
  const statusLine = isNew ? (
    <span className="inline-flex items-center gap-1 font-medium text-primary">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
      {t('conversation.newCustomer', { defaultValue: 'New customer' })}
    </span>
  ) : customerPresence ? (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          customerPresence.online ? 'bg-success' : 'bg-muted-foreground/40',
        )}
      />
      {customerPresence.online
        ? t('conversation.online', { defaultValue: 'Online' })
        : t('conversation.offline', { defaultValue: 'Offline' })}
    </span>
  ) : (
    (contact?.email ?? contact?.phone ?? null)
  );

  // Read-only at-a-glance tag strip; full management lives in the details sidebar.
  const tagChips = conversation.tags?.filter((j) => j.tags_id) ?? [];

  const currentAgent = agents.data?.find((a) => a.id === conversation.assigned_agent);
  const currentTeam = teams.data?.find((tm) => tm.id === conversation.assigned_team);
  const agentLabel =
    currentAgent?.first_name ?? currentAgent?.email ?? t('conversation.unassigned');
  const teamLabel = currentTeam?.name ?? t('conversation.noTeam');

  const statusDot: Record<ConversationStatus, string> = {
    open: 'bg-success',
    pending: 'bg-warning',
    resolved: 'bg-primary',
    closed: 'bg-muted-foreground/50',
  };

  // A conversation carries at most one ticket (SC-013). If it already has one we
  // point at it rather than offering to create a second (which the DB would
  // reject on the unique constraint).
  const existingTicket = linkedTickets.data?.[0] ?? null;
  const canCreateTicket = !!conversation.contact?.id && !!vendorId;
  const isWrappedUp = conversation.status === 'resolved' || conversation.status === 'closed';
  // #6: prompt to spin a ticket out of a chat that's been closed/resolved but has
  // no ticket yet. Suppressed once dismissed, once a ticket exists, or when we
  // lack the ids needed to create one.
  const showTicketPrompt =
    isWrappedUp &&
    !existingTicket &&
    !promptDismissed &&
    canCreateTicket &&
    !linkedTickets.isLoading;

  return (
    <>
      {/* Line-free floating header: tonal surface + spacing, no hairline. */}
      <div className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-card/50 px-3 py-2.5 backdrop-blur sm:px-5">
        {/* Back to inbox list — mobile single-column only. */}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('conversation.backToInbox', { defaultValue: 'Back to inbox' })}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-fast ease-out hover:bg-secondary active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:hidden"
          >
            <ArrowLeftIcon size={18} className="rtl:-scale-x-100" />
          </button>
        )}

        {/* Identity — clean: a status-dotted avatar + name + email. The status &
          priority live in the controls on the right, so no duplicate pills. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="relative shrink-0">
            <span className="block rounded-full bg-gradient-to-br from-primary to-violet p-[2px]">
              <span className="block rounded-full bg-background p-[2px]">
                <Avatar
                  name={conversation.contact?.name}
                  email={conversation.contact?.email}
                  phone={conversation.contact?.phone}
                  size="md"
                />
              </span>
            </span>
            <span
              className={cn(
                'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-background',
                statusDot[conversation.status],
              )}
              aria-hidden
            />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{primaryLabel}</div>
            {statusLine && (
              <div className="truncate text-xs text-muted-foreground">{statusLine}</div>
            )}
            {/* At-a-glance tags (read-only). Hidden on small screens to keep the
              identity compact; managed in the details sidebar. */}
            {tagChips.length > 0 && (
              <div className="mt-1 hidden flex-wrap items-center gap-1 lg:flex">
                {tagChips.map((j) => (
                  <span
                    key={j.id}
                    className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-px text-[10px] font-medium text-foreground/75"
                  >
                    <span
                      aria-hidden
                      className="h-1 w-1 shrink-0 rounded-full"
                      style={{ background: j.tags_id!.color ?? '#94a3b8' }}
                    />
                    <span className="max-w-[8rem] truncate">{j.tags_id!.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Properties + actions. Wraps to a second line on narrow widths (the bar
          grows with it — `min-h-14`, not a fixed height — so it never overlaps
          the thread below). Selects are grouped into one subtle cluster so they
          read as conversation properties rather than scattered controls. */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex flex-wrap items-center gap-0.5 rounded-full bg-secondary/60 px-1.5 py-1">
            <GhostSelect
              size="sm"
              label={t('conversation.status')}
              aria-label={t('conversation.status')}
              value={conversation.status}
              display={t(`status.${conversation.status}`, { ns: 'common' })}
              onChange={(v) => void patch({ status: v as ConversationStatus })}
              options={STATUSES.map((s) => ({
                value: s,
                label: t(`status.${s}`, { ns: 'common' }),
              }))}
            />
            <GhostSelect
              size="sm"
              label={t('conversation.priority')}
              aria-label={t('conversation.priority')}
              value={conversation.priority}
              display={t(`priority.${conversation.priority}`, { ns: 'common' })}
              onChange={(v) => void patch({ priority: v as Priority })}
              options={PRIORITIES.map((p) => ({
                value: p,
                label: t(`priority.${p}`, { ns: 'common' }),
              }))}
            />
            <GhostSelect
              size="sm"
              label={t('conversation.agent')}
              aria-label={t('conversation.agent')}
              value={conversation.assigned_agent ?? ''}
              display={agentLabel}
              onChange={(v) => void patch({ assigned_agent: v || null })}
              options={[
                { value: '', label: t('conversation.unassigned') },
                ...(agents.data ?? []).map((a) => ({
                  value: a.id,
                  label: a.first_name ?? a.email ?? '',
                })),
              ]}
            />
            <GhostSelect
              size="sm"
              label={t('conversation.team')}
              aria-label={t('conversation.team')}
              value={conversation.assigned_team ?? ''}
              display={teamLabel}
              onChange={(v) => void patch({ assigned_team: v || null })}
              options={[
                { value: '', label: t('conversation.noTeam') },
                ...(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })),
              ]}
            />
          </div>

          {existingTicket ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/tickets/${existingTicket.id}`)}
            >
              {t('tickets.viewTicket', { defaultValue: 'View ticket' })}
            </Button>
          ) : (
            // SC-013: a conversation carries at most one ticket. `existingTicket` is
            // null while the linked-tickets query is still loading, so we must also
            // gate on `!linkedTickets.isLoading` — otherwise this button is clickable
            // during the load window and a duplicate ticket becomes reachable (and
            // two agents on the same thread could both create one). This is a UX
            // guard only; the authoritative backstop is a unique index on
            // tickets.conversation owned by the infra/directus stream
            // (directus/bootstrap/src/constraints.ts) — do NOT add the DB constraint here.
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!canCreateTicket || linkedTickets.isLoading}
              onClick={() => setOpenTicketDialog(true)}
            >
              + {t('tickets.createTitle')}
            </Button>
          )}

          {/* Details / notes panel toggle — mobile single-column only. */}
          {onToggleDetails && (
            <button
              type="button"
              onClick={onToggleDetails}
              aria-label={t('conversation.details', { defaultValue: 'Conversation details' })}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors duration-fast ease-out hover:bg-secondary active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:hidden"
            >
              <InfoIcon size={18} />
            </button>
          )}
        </div>
      </div>

      {/* #6 — every chat should end as a ticket. When the conversation is
          resolved/closed with no ticket yet, surface a one-tap prompt to spin
          one out (carrying this chat's order + files, see CreateTicketDialog). */}
      {showTicketPrompt && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/20 bg-primary-subtle/60 px-3 py-2.5 sm:px-5 motion-safe:animate-fade-in">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
            <span className="font-medium">
              {t('tickets.chatEndedPromptTitle', { defaultValue: 'This chat is wrapped up.' })}
            </span>{' '}
            <span className="text-muted-foreground">
              {t('tickets.chatEndedPromptBody', {
                defaultValue:
                  'Create a ticket to track any follow-up — the order and files from this chat come with it.',
              })}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" size="sm" onClick={() => setOpenTicketDialog(true)}>
              {t('tickets.createFromChat', { defaultValue: 'Create ticket' })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPromptDismissed(true)}
            >
              {t('tickets.dismissPrompt', { defaultValue: 'Dismiss' })}
            </Button>
          </div>
        </div>
      )}

      {openTicketDialog && conversation.contact?.id && vendorId && (
        <CreateTicketDialog
          contactId={conversation.contact.id}
          vendorId={vendorId}
          conversationId={conversation.id}
          onClose={() => setOpenTicketDialog(false)}
        />
      )}
    </>
  );
}
