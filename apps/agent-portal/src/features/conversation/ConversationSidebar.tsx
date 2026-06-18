import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  Input,
  Pill,
  ResizeHandle,
  Spinner,
  toast,
  formatRelative,
  useResizable,
} from '@yiji/ui';
import { useConversation, useLinkedTickets, type ConversationMessage } from '../inbox/api.js';
import { useUpdateContact } from '../contacts/api.js';
import { AiPanel } from '../ai/AiPanel.js';
import { ConversationTags } from './ConversationTags.js';
import { CustomFieldsSection } from '../custom-fields/CustomFieldsSection.js';

interface Props {
  conversationId: string;
  notes?: ConversationMessage[];
  onDeleteNote?: (noteId: string) => void;
  /** Width/utility override. Defaults to the desktop `w-80` rail width. */
  className?: string;
  /** Desktop only: make the panel drag-resizable from its leading edge. */
  resizable?: boolean;
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      <span>{children}</span>
      {count !== undefined && count > 0 && (
        <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-secondary px-1 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </h3>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5z" />
    </svg>
  );
}

const TICKET_TONE: Record<string, 'success' | 'warning' | 'muted' | 'primary' | 'neutral'> = {
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
  reopened: 'neutral',
};

export function ConversationSidebar({
  conversationId,
  notes,
  onDeleteNote,
  className,
  resizable,
}: Props) {
  const { t } = useTranslation();
  const convo = useConversation(conversationId);
  const tickets = useLinkedTickets(conversationId);
  const updateContact = useUpdateContact();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  // Drop out of edit mode when switching conversations so a stale draft never
  // overwrites a different customer.
  useEffect(() => setEditing(false), [conversationId]);
  const rs = useResizable({
    storageKey: 'yiji.agent.convoSidebarWidth',
    defaultWidth: 320,
    min: 264,
    max: 480,
    side: 'end',
  });
  const sizeProps = resizable ? { style: { width: rs.width } } : undefined;
  const widthClass = resizable ? '' : 'w-80';
  const handle = resizable ? (
    <ResizeHandle
      bind={rs.bind}
      dragging={rs.dragging}
      side="end"
      label={t('sidebar.resizePanel', { defaultValue: 'Resize details panel' })}
    />
  ) : null;

  if (convo.isLoading)
    return (
      <aside
        className={cn('relative flex shrink-0 items-center justify-center', widthClass, className)}
        {...sizeProps}
      >
        {handle}
        <Spinner />
      </aside>
    );
  if (!convo.data) return null;
  const c = convo.data;
  const contactName = c.contact?.name ?? t('inbox.unknownContact');

  const startEdit = () => {
    setDraft({
      name: c.contact?.name ?? '',
      email: c.contact?.email ?? '',
      phone: c.contact?.phone ?? '',
    });
    setEditing(true);
  };
  const saveContact = async () => {
    if (!c.contact?.id) return;
    try {
      await updateContact.mutateAsync({
        id: c.contact.id,
        patch: {
          name: draft.name.trim() || null,
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
        },
      });
      toast.success(
        t('sidebar.contactSaved', { defaultValue: 'Customer details saved everywhere.' }),
      );
      setEditing(false);
    } catch {
      toast.error(
        t('sidebar.contactSaveError', { defaultValue: 'Could not save customer details.' }),
      );
    }
  };

  return (
    <aside className={cn('relative shrink-0 overflow-auto', widthClass, className)} {...sizeProps}>
      {handle}
      {/* Identity — big avatar in a mesh halo, no border below. */}
      <div className="relative overflow-hidden px-6 pb-6 pt-7">
        <div
          aria-hidden
          className="absolute inset-0 opacity-90"
          style={{
            background:
              'radial-gradient(at 0% 0%, oklch(var(--primary) / 0.10) 0%, transparent 60%), radial-gradient(at 100% 100%, oklch(var(--secondary-brand) / 0.10) 0%, transparent 65%)',
          }}
        />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <Avatar name={c.contact?.name} email={c.contact?.email} size="lg" />
          <div className="space-y-1.5">
            <h3 className="text-lg font-bold tracking-tight text-foreground">{contactName}</h3>
            <Pill tone="pink" size="sm">
              {t('sidebar.channelWidget')}
            </Pill>
          </div>
        </div>
      </div>

      {/* Contact details — editable: agents can correct the customer's name,
          email or phone; saving persists to Directus and updates everywhere. */}
      <section className="px-6 py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('sidebar.contact')}
          </h3>
          {c.contact?.id && !editing && (
            <button
              type="button"
              onClick={startEdit}
              aria-label={t('sidebar.editContact', { defaultValue: 'Edit customer details' })}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <PencilIcon />
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2.5 text-xs">
            <label className="block">
              <span className="mb-1 block text-muted-foreground">
                {t('sidebar.name', { defaultValue: 'Name' })}
              </span>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder={t('inbox.unknownContact')}
                aria-label={t('sidebar.name', { defaultValue: 'Name' })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted-foreground">{t('sidebar.email')}</span>
              <Input
                type="email"
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                aria-label={t('sidebar.email')}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted-foreground">{t('sidebar.phone')}</span>
              <Input
                type="tel"
                value={draft.phone}
                onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                aria-label={t('sidebar.phone')}
              />
            </label>
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => void saveContact()}
                loading={updateContact.isPending}
              >
                {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={updateContact.isPending}
              >
                {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
              </Button>
            </div>
          </div>
        ) : (
          <dl className="space-y-2.5 text-xs">
            {c.contact?.email && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{t('sidebar.email')}</dt>
                <dd className="truncate font-medium text-foreground">{c.contact.email}</dd>
              </div>
            )}
            {c.contact?.phone && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{t('sidebar.phone')}</dt>
                <dd className="tabular-nums font-medium text-foreground">{c.contact.phone}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('sidebar.source')}</dt>
              <dd className="font-medium text-foreground">{t('sidebar.sourceWidget')}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* Tags — the single, interactive home for conversation tags. */}
      <section className="px-6 py-4">
        <ConversationTags conversation={c} />
      </section>

      {/* Custom fields (per-conversation) */}
      <section className="px-6 py-4">
        <CustomFieldsSection entityType="conversation" entityId={conversationId} />
      </section>

      {/* AI assistance */}
      <section className="px-6 py-4">
        <AiPanel
          conversationId={conversationId}
          vendorId={
            (c as unknown as { vendor?: string | { id: string } }).vendor &&
            typeof (c as unknown as { vendor?: string | { id: string } }).vendor === 'object'
              ? (c as unknown as { vendor: { id: string } }).vendor.id
              : ((c as unknown as { vendor?: string }).vendor ?? 'unknown')
          }
        />
      </section>

      {/* Internal notes — agent-only side conversation. Authored by the team,
          rendered out of the customer thread so they can't bleed in visually. */}
      <section className="px-6 py-4">
        <SectionLabel count={notes?.length}>
          {t('sidebar.internalNotes', { defaultValue: 'Internal notes' })}
        </SectionLabel>
        {notes && notes.length > 0 ? (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className="group relative rounded-lg border-s-2 border-warning/50 bg-warning/10 ps-3 pe-3 py-2.5"
              >
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                  {n.content}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                  <span className="tabular-nums">
                    {n.date_created ? formatRelative(n.date_created) : ''}
                  </span>
                  {onDeleteNote && (
                    <button
                      type="button"
                      onClick={() => onDeleteNote(n.id)}
                      aria-label={t('sidebar.removeNote', { defaultValue: 'Remove note' })}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-warning/20 hover:text-warning focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-warning/50 group-hover:opacity-100"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-3.5 w-3.5"
                        aria-hidden
                      >
                        <path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 4M7 7v4M9 7v4" />
                      </svg>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('sidebar.noNotes', { defaultValue: 'No internal notes yet.' })}
          </p>
        )}
      </section>

      {/* Linked tickets — borderless rows with hover lift, not stacked cards. */}
      <section className="px-6 py-4 pb-8">
        <SectionLabel count={tickets.data?.length}>{t('sidebar.linkedTickets')}</SectionLabel>
        {tickets.isLoading ? (
          <Spinner />
        ) : tickets.data && tickets.data.length > 0 ? (
          <ul className="-mx-2 space-y-0.5">
            {tickets.data.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  className="block w-full rounded-md px-2 py-2 text-start transition-colors duration-fast ease-out hover:bg-secondary/70"
                >
                  <div className="truncate text-sm font-medium text-foreground">{tk.subject}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Pill tone={TICKET_TONE[tk.status] ?? 'neutral'} size="sm">
                      {t(`status.${tk.status}`, { ns: 'common' })}
                    </Pill>
                    <Pill tone="muted" size="sm">
                      {t(`priority.${tk.priority}`, { ns: 'common' })}
                    </Pill>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('sidebar.noTickets')}</p>
        )}
      </section>
    </aside>
  );
}
