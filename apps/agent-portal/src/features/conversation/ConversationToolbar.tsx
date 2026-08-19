import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, Avatar, Button, cn, GhostSelect, InfoIcon, toast } from '@yiji/ui';
import {
  SOCKET_EVENTS,
  normaliseConversationStatus,
  type ConversationStatus,
  type Priority,
} from '@yiji/shared-types';
import {
  conversationVendorId,
  leastLoadedAgentInTeam,
  useAgents,
  useLinkedTickets,
  useTeamOptions,
  useUpdateConversation,
  type InboxConversation,
} from '../inbox/api.js';
import { getSocket } from '../../lib/socket.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/** Leading check on the "Mark as solved" button. */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="m3 8.5 3.5 3.5L13 4.5" />
    </svg>
  );
}

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
  // Raising a ticket is a full page, the same one the sidebar's order id opens.
  // One screen for one task: two different shapes for "new ticket" is the kind
  // of inconsistency agents learn around rather than notice.
  const openNewTicket = () =>
    navigate(`/new-ticket?conversation=${encodeURIComponent(conversation.id)}`);
  // #6: once a chat is closed/resolved, nudge the agent to turn it into a ticket
  // so no conversation is left without a follow-up record. Dismissible, and reset
  // per conversation so a dismissal doesn't leak across threads.
  const [promptDismissed, setPromptDismissed] = useState(false);
  useEffect(() => setPromptDismissed(false), [conversation.id]);

  const vendorId = conversationVendorId(conversation);

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

  /**
   * Hand the chat to a team — the shift handover.
   *
   * Setting the team alone would leave the chat owned by whoever has it now,
   * which for a night-to-day handover is precisely the person going home. So
   * the chat also moves to the least-loaded agent ON that team, and the whole
   * team can see it (Directus scopes conversation reads by
   * `assigned_team = $CURRENT_USER.team`).
   *
   * Picking here rather than leaving it to the routing ladder is deliberate:
   * the agent doing the handover watches the assignee change in front of them,
   * so "I passed it to days" and "days has it" are the same moment.
   *
   * Clearing the team leaves the assignee alone. The chat still has an owner —
   * removing a label is not a reason to take work away from somebody.
   */
  const handoverToTeam = async (teamId: string | null) => {
    if (!teamId) {
      await patch({ assigned_team: null });
      return;
    }
    const member = await leastLoadedAgentInTeam(teamId);
    await patch({
      assigned_team: teamId,
      // No member found means the team has nobody in it yet. Record the team
      // anyway — the label is still true — but say so, because a handover to
      // an empty team is a chat nobody is going to answer.
      ...(member ? { assigned_agent: member } : {}),
    });
    if (!member) {
      // Covers both "the team is empty" and "we could not measure who is
      // free" — in either case nobody was chosen, and the agent needs to know
      // the handover did not pick an owner rather than assume it balanced.
      toast.warning(
        t('conversation.teamNoPick', {
          defaultValue:
            'No agent was picked for that team — the chat stays with its current owner. Assign someone directly if it needs an owner now.',
        }),
      );
    }
  };

  // Read-only at-a-glance tag strip; full management lives in the details sidebar.
  const tagChips = conversation.tags?.filter((j) => j.tags_id) ?? [];

  const currentAgent = agents.data?.find((a) => a.id === conversation.assigned_agent);
  const currentTeam = teams.data?.find((tm) => tm.id === conversation.assigned_team);
  const agentLabel =
    currentAgent?.first_name ?? currentAgent?.email ?? t('conversation.unassigned');
  const teamLabel = currentTeam?.name ?? t('conversation.noTeam');

  const statusDot: Record<ConversationStatus, string> = {
    open: 'bg-success',
    solved: 'bg-primary',
  };

  /**
   * Which ticket "View ticket" opens: the NEWEST one raised from this chat.
   *
   * A conversation was meant to carry at most one ticket (SC-013), but in
   * practice several can accumulate, and then the button's destination was
   * whatever the query happened to return first — an agent clicking it could
   * not say in advance where they would land. It is sorted here as well as in
   * the query so the answer stays "the latest" even if that query's ordering is
   * ever changed for another caller.
   */
  const existingTicket =
    [...(linkedTickets.data ?? [])].sort((a, b) =>
      (b.date_created ?? '').localeCompare(a.date_created ?? ''),
    )[0] ?? null;
  const linkedCount = linkedTickets.data?.length ?? 0;
  const canCreateTicket = !!conversation.contact?.id && !!vendorId;
  // Read through the normaliser rather than comparing directly: a database that
  // has not run scripts/migrate-conversation-status.mjs still holds 'resolved'
  // and 'closed', and a strict compare would show those finished chats as
  // unfinished work.
  const isSolved = normaliseConversationStatus(conversation.status) === 'solved';
  // #6: prompt to spin a ticket out of a chat that's been closed/resolved but has
  // no ticket yet. Suppressed once dismissed, once a ticket exists, or when we
  // lack the ids needed to create one.
  const showTicketPrompt =
    isSolved && !existingTicket && !promptDismissed && canCreateTicket && !linkedTickets.isLoading;

  return (
    <>
      {/* Board header strip: card surface closed off by a hairline rule, the
          same separator grammar as the list rows below it. */}
      <div className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-foreground/[0.06] bg-card px-3 py-2.5 sm:px-5">
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
            <span className="block rounded-full bg-primary/30 p-[2px]">
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
                    {/* Tag colours are user data (inline style); the colourless
                        fallback is a token, not a hardcoded slate hex. */}
                    <span
                      aria-hidden
                      className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"
                      style={j.tags_id!.color ? { background: j.tags_id!.color } : undefined}
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
          <div className="flex flex-wrap items-center gap-0.5 rounded-xl bg-secondary/40 p-1 ring-1 ring-inset ring-foreground/[0.06]">
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
              onChange={(v) => void handoverToTeam(v || null)}
              options={[
                { value: '', label: t('conversation.noTeam') },
                ...(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })),
              ]}
            />
          </div>

          {/* Product change (2026-07-26): a conversation may carry MULTIPLE
              tickets, so Create ticket is always offered. Existing tickets
              stay reachable via the sidebar's Linked tickets list (and the
              quick View ticket shortcut below when one exists). The old
              SC-013 one-ticket rule and its UX guard are retired; no DB
              unique constraint exists on tickets.conversation. */}
          {/* The case toggle. Two states only — solved or pending — because the
              operations team tracks a case as "dealt with or not", and the four
              raw statuses only ever produced arguments about the difference
              between open and pending. Solved is a positive terminal action, so
              it gets a primary-weight button in its own hue; once solved it
              steps back to a quiet outline, since the case needs nothing more.
              A new customer message flips it back automatically (gateway). */}
          <Button
            type="button"
            variant={isSolved ? 'outline' : 'success'}
            size="sm"
            iconStart={isSolved ? undefined : <CheckIcon />}
            onClick={() =>
              // solved_at is stamped here rather than derived later: the status
              // says WHETHER a chat is finished, never WHEN, and agent
              // performance measures time-to-solve from exactly this moment.
              // Reopening clears it, so a reopened chat is not still carrying a
              // solve time that never happened.
              void patch(
                isSolved
                  ? { status: 'open', solved_at: null }
                  : { status: 'solved', solved_at: new Date().toISOString() },
              )
            }
            title={
              isSolved
                ? t('conversation.solvedHint', {
                    defaultValue: 'Solved. Reopen it if the case is not finished.',
                  })
                : undefined
            }
          >
            {isSolved
              ? t('conversation.markOpen', { defaultValue: 'Reopen' })
              : t('conversation.markSolved', { defaultValue: 'Mark as solved' })}
          </Button>

          {existingTicket && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/tickets/${existingTicket.id}`)}
              // Names the destination, so a chat with several tickets does not
              // make the button a guess.
              title={
                linkedCount > 1
                  ? t('tickets.viewLatestOf', {
                      defaultValue: 'Opens the latest of {{n}} tickets: {{subject}}',
                      n: linkedCount,
                      subject: existingTicket.subject ?? '',
                    })
                  : (existingTicket.subject ?? undefined)
              }
            >
              {linkedCount > 1
                ? t('tickets.viewLatestTicket', { defaultValue: 'View latest ticket' })
                : t('tickets.viewTicket', { defaultValue: 'View ticket' })}
            </Button>
          )}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!canCreateTicket}
            onClick={openNewTicket}
          >
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
      </div>

      {/* #6 — every chat should end as a ticket. When the conversation is
          resolved/closed with no ticket yet, surface a one-tap prompt to spin
          one out (carrying this chat's order + files, see CreateTicketDialog). */}
      {/* bg-primary/10, not bg-primary-subtle/60 — the subtle token embeds
          its own alpha, so any expansion of it is invalid CSS and the strip's
          wash silently painted nothing (design-law token-alpha trap). */}
      {showTicketPrompt && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/20 bg-primary/10 px-3 py-2.5 sm:px-5 motion-safe:animate-fade-in">
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
            <Button type="button" size="sm" onClick={openNewTicket}>
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
    </>
  );
}
