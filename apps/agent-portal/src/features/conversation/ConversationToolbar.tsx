import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, Avatar, Button, cn, GhostSelect, InfoIcon, toast } from '@yiji/ui';
import { SOCKET_EVENTS, type ConversationStatus, type Priority } from '@yiji/shared-types';
import {
  useAgents,
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
  /** Mobile-only: return to the inbox list (single-column view). */
  onBack?: () => void;
  /** Mobile-only: open the conversation details/notes panel. */
  onToggleDetails?: () => void;
}

export function ConversationToolbar({ conversation, onBack, onToggleDetails }: Props) {
  const { t } = useTranslation();
  const agents = useAgents();
  const teams = useTeamOptions();
  const update = useUpdateConversation();
  const [openTicketDialog, setOpenTicketDialog] = useState(false);

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

  const contactName = conversation.contact?.name ?? conversation.contact?.email ?? 'Customer';

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

  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/50 px-3 py-2 sm:px-5">
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
          <Avatar name={conversation.contact?.name} email={conversation.contact?.email} size="md" />
          <span
            className={cn(
              'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-card',
              statusDot[conversation.status],
            )}
            aria-hidden
          />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{contactName}</div>
          {conversation.contact?.email && (
            <div className="truncate text-xs text-muted-foreground">
              {conversation.contact.email}
            </div>
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
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-secondary/50 px-1 py-0.5">
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

        <Button type="button" variant="default" size="sm" onClick={() => setOpenTicketDialog(true)}>
          + {t('tickets.createTitle')}
        </Button>

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

      {openTicketDialog && conversation.contact?.id && vendorId && (
        <CreateTicketDialog
          contactId={conversation.contact.id}
          vendorId={vendorId}
          conversationId={conversation.id}
          onClose={() => setOpenTicketDialog(false)}
        />
      )}
    </div>
  );
}
