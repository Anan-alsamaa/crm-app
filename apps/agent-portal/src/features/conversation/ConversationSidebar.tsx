import { useTranslation } from 'react-i18next';
import { Avatar, Pill, Spinner, formatRelative } from '@yiji/ui';
import { useConversation, useLinkedTickets, type ConversationMessage } from '../inbox/api.js';
import { AiPanel } from '../ai/AiPanel.js';
import { CustomFieldsSection } from '../custom-fields/CustomFieldsSection.js';

interface Props {
  conversationId: string;
  notes?: ConversationMessage[];
  onDeleteNote?: (noteId: string) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </h3>
  );
}

const TICKET_TONE: Record<string, 'success' | 'warning' | 'muted' | 'primary' | 'neutral'> = {
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
  reopened: 'neutral',
};

export function ConversationSidebar({ conversationId, notes, onDeleteNote }: Props) {
  const { t } = useTranslation();
  const convo = useConversation(conversationId);
  const tickets = useLinkedTickets(conversationId);

  if (convo.isLoading)
    return (
      <aside className="flex w-80 items-center justify-center ">
        <Spinner />
      </aside>
    );
  if (!convo.data) return null;
  const c = convo.data;
  const contactName = c.contact?.name ?? t('inbox.unknownContact');

  return (
    <aside className="w-80 shrink-0 overflow-auto ">
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
              widget · web
            </Pill>
          </div>
        </div>
      </div>

      {/* Contact details — borderless key/value list. */}
      <section className="px-6 py-4">
        <SectionLabel>{t('sidebar.contact')}</SectionLabel>
        <dl className="space-y-2.5 text-xs">
          {c.contact?.email && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="truncate font-medium text-foreground">{c.contact.email}</dd>
            </div>
          )}
          {c.contact?.phone && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="tabular-nums font-medium text-foreground">{c.contact.phone}</dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Source</dt>
            <dd className="font-medium text-foreground">Web widget</dd>
          </div>
        </dl>
      </section>

      {/* Tags */}
      {c.tags && c.tags.length > 0 && (
        <section className="px-6 py-4">
          <SectionLabel>{t('sidebar.tags')}</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {c.tags.map((tg) =>
              tg.tags_id ? (
                <span
                  key={tg.tags_id.id}
                  className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-foreground"
                  style={
                    tg.tags_id.color
                      ? { background: `${tg.tags_id.color}24`, color: tg.tags_id.color }
                      : undefined
                  }
                >
                  {tg.tags_id.name}
                </span>
              ) : null,
            )}
          </div>
        </section>
      )}

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
        <SectionLabel>
          {t('sidebar.internalNotes', { defaultValue: 'Internal notes' })}
        </SectionLabel>
        {notes && notes.length > 0 ? (
          <ul className="space-y-2.5">
            {notes.map((n) => (
              <li
                key={n.id}
                className="group relative rounded-lg bg-warning/10 px-3 py-2.5 ring-1 ring-warning/20"
              >
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                  {n.content}
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
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
        <SectionLabel>{t('sidebar.linkedTickets')}</SectionLabel>
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
