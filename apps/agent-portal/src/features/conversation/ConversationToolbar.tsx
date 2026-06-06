import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, Avatar, Button, cn, GhostSelect, InfoIcon, Pill, toast } from '@yiji/ui';
import { SOCKET_EVENTS, type ConversationStatus, type Priority } from '@yiji/shared-types';
import {
  useAgents,
  useTeamOptions,
  useTags,
  useAddTagToConversation,
  useUpdateConversation,
  type InboxConversation,
} from '../inbox/api.js';
import { getSocket } from '../../lib/socket.js';
import { CreateTicketDialog } from '../tickets/CreateTicketDialog.js';

const STATUSES: ConversationStatus[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

const STATUS_TONE: Record<ConversationStatus, 'success' | 'warning' | 'muted' | 'primary'> = {
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};

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
  const tags = useTags();
  const update = useUpdateConversation();
  const addTag = useAddTagToConversation();
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

  const currentAgent = agents.data?.find((a) => a.id === conversation.assigned_agent);
  const currentTeam = teams.data?.find((tm) => tm.id === conversation.assigned_team);
  const agentLabel =
    currentAgent?.first_name ?? currentAgent?.email ?? t('conversation.unassigned');
  const teamLabel = currentTeam?.name ?? t('conversation.noTeam');

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 px-3 sm:px-5">
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

      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={conversation.contact?.name} email={conversation.contact?.email} size="md" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{contactName}</span>
            <Pill tone={STATUS_TONE[conversation.status]} size="sm">
              {t(`status.${conversation.status}`, { ns: 'common' })}
            </Pill>
            {conversation.priority !== 'medium' && conversation.priority !== 'low' && (
              <Pill tone={conversation.priority === 'urgent' ? 'pink' : 'orange'} size="sm">
                {t(`priority.${conversation.priority}`, { ns: 'common' })}
              </Pill>
            )}
          </div>
          {conversation.contact?.email && (
            <div className="truncate text-xs text-muted-foreground">
              {conversation.contact.email}
            </div>
          )}
        </div>
      </div>

      {/* Inline meta — reads as breadcrumbs, not form fields. Single scrollable
          row at every size so it never wraps below the fixed-height bar and
          overlaps the conversation thread. */}
      <div className="ms-auto flex min-w-0 items-center gap-0.5 overflow-x-auto">
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
        <span className="px-0.5 text-muted-foreground/40" aria-hidden>
          ·
        </span>
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
        <span className="px-0.5 text-muted-foreground/40" aria-hidden>
          ·
        </span>
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
        <span className="px-0.5 text-muted-foreground/40" aria-hidden>
          ·
        </span>
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

        {/* Tag — collapsed until you reach for one */}
        <details className="group relative ms-1">
          <summary
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-fast ease-out',
              'hover:bg-secondary/70 [&::-webkit-details-marker]:hidden',
            )}
          >
            <span className="text-sm leading-none">+</span>
            <span>{t('conversation.addTag')}</span>
          </summary>
          <div className="absolute end-0 z-30 mt-1 min-w-[10rem] rounded-2xl bg-popover p-1.5 shadow-xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in origin-top-end">
            {tags.data?.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No tags yet.</p>
            )}
            {tags.data?.map((tg) => (
              <button
                key={tg.id}
                type="button"
                onClick={async () => {
                  try {
                    await addTag.mutateAsync({ conversationId: conversation.id, tagId: tg.id });
                    await broadcastUpdate(conversation.id);
                  } catch {
                    toast.error(t('errors.updateFailed', { ns: 'common' }));
                  }
                }}
                className="block w-full rounded-sm px-2 py-1.5 text-start text-xs hover:bg-secondary"
              >
                {tg.name}
              </button>
            ))}
          </div>
        </details>

        <Button
          type="button"
          variant="default"
          size="sm"
          className="ms-2"
          onClick={() => setOpenTicketDialog(true)}
        >
          + {t('tickets.createTitle')}
        </Button>
      </div>

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
