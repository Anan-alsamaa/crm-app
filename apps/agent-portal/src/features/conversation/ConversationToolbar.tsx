import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  cn,
  CloseIcon,
  GhostSelect,
  InfoIcon,
  toast,
} from '@yiji/ui';
import { SOCKET_EVENTS, type ConversationStatus, type Priority } from '@yiji/shared-types';
import {
  useAgents,
  useTeamOptions,
  useTags,
  useAddTagToConversation,
  useRemoveTagFromConversation,
  useCreateTag,
  useUpdateConversation,
  type InboxConversation,
} from '../inbox/api.js';
import { getSocket } from '../../lib/socket.js';
import { CreateTicketDialog } from '../tickets/CreateTicketDialog.js';

const STATUSES: ConversationStatus[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/** A conversation can carry at most this many tags. */
const MAX_TAGS = 5;

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
  const removeTag = useRemoveTagFromConversation();
  const createTag = useCreateTag();
  const [openTicketDialog, setOpenTicketDialog] = useState(false);
  const [newTag, setNewTag] = useState('');

  const assigned = conversation.tags?.filter((j) => j.tags_id) ?? [];
  const assignedIds = new Set(assigned.map((j) => j.tags_id!.id));
  const available = (tags.data ?? []).filter((tg) => !assignedIds.has(tg.id));
  const atMax = assigned.length >= MAX_TAGS;
  const limitMsg = t('conversation.tagLimit', {
    count: MAX_TAGS,
    defaultValue: `Up to ${MAX_TAGS} tags per conversation.`,
  });

  const assignTag = async (tagId: string) => {
    if (atMax) {
      toast.error(limitMsg);
      return;
    }
    try {
      await addTag.mutateAsync({ conversationId: conversation.id, tagId });
      await broadcastUpdate(conversation.id);
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const createAndAssign = async () => {
    const name = newTag.trim();
    if (!name) return;
    if (atMax) {
      toast.error(limitMsg);
      return;
    }
    try {
      const existing = (tags.data ?? []).find((tg) => tg.name.toLowerCase() === name.toLowerCase());
      // Already on this conversation — don't create a duplicate junction row.
      if (existing && assignedIds.has(existing.id)) {
        setNewTag('');
        return;
      }
      const tagId = existing ? existing.id : (await createTag.mutateAsync({ name })).id;
      await addTag.mutateAsync({ conversationId: conversation.id, tagId });
      await broadcastUpdate(conversation.id);
      setNewTag('');
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const unassignTag = async (junctionId: string) => {
    try {
      await removeTag.mutateAsync({ junctionId, conversationId: conversation.id });
      await broadcastUpdate(conversation.id);
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

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

        {/* Assigned tags — removable chips, with a brand-coloured dot. */}
        {assigned.map((j) => (
          <span
            key={j.id}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-2xs font-medium text-foreground/80"
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: j.tags_id!.color ?? '#94a3b8' }}
            />
            {j.tags_id!.name}
            <button
              type="button"
              onClick={() => void unassignTag(j.id)}
              aria-label={t('conversation.removeTag', { defaultValue: 'Remove tag' })}
              className="text-muted-foreground transition-colors duration-fast hover:text-foreground"
            >
              <CloseIcon size={11} />
            </button>
          </span>
        ))}

        {/* Add / create tag — type to create a new one, or pick an existing.
            Disabled once the conversation hits the MAX_TAGS cap. */}
        {atMax ? (
          <span
            className="inline-flex h-7 cursor-default items-center gap-1 rounded-md px-2 text-xs text-muted-foreground/70"
            title={limitMsg}
          >
            {t('conversation.tagsFull', {
              count: MAX_TAGS,
              defaultValue: `${MAX_TAGS}/${MAX_TAGS} tags`,
            })}
          </span>
        ) : (
          <details className="group relative">
            <summary
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-fast ease-out',
                'hover:bg-secondary/70 [&::-webkit-details-marker]:hidden',
              )}
            >
              <span className="text-sm leading-none">+</span>
              <span>{t('conversation.addTag')}</span>
            </summary>
            <div className="absolute end-0 z-30 mt-1 w-56 rounded-2xl bg-popover p-1.5 shadow-xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in origin-top-end">
              <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-2xs text-muted-foreground">
                <span>{t('conversation.addTag')}</span>
                <span className="tabular-nums">
                  {assigned.length}/{MAX_TAGS}
                </span>
              </div>
              <div className="flex items-center gap-1 p-1">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void createAndAssign();
                  }
                }}
                placeholder={t('conversation.newTagPlaceholder', { defaultValue: 'Create a tag…' })}
                aria-label={t('conversation.newTagPlaceholder', { defaultValue: 'Create a tag' })}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              {newTag.trim() && (
                <button
                  type="button"
                  onClick={() => void createAndAssign()}
                  className="inline-flex h-7 shrink-0 items-center rounded-md bg-foreground px-2 text-2xs font-semibold text-background hover:bg-foreground/90"
                >
                  {t('actions.add', { ns: 'common', defaultValue: 'Add' })}
                </button>
              )}
            </div>
            <div className="mt-1 max-h-56 overflow-auto">
              {available.length === 0 && newTag.trim().length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('conversation.noMoreTags', {
                    defaultValue: 'No tags yet — type to create one.',
                  })}
                </p>
              )}
              {available
                .filter((tg) => tg.name.toLowerCase().includes(newTag.trim().toLowerCase()))
                .map((tg) => (
                  <button
                    key={tg.id}
                    type="button"
                    onClick={() => void assignTag(tg.id)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-xs hover:bg-secondary"
                  >
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: tg.color ?? '#94a3b8' }}
                    />
                    <span className="truncate">{tg.name}</span>
                  </button>
                ))}
            </div>
            </div>
          </details>
        )}

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
