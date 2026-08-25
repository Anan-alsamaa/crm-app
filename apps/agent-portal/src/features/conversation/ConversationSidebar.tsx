import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  Input,
  Ltr,
  Pill,
  ResizeHandle,
  Spinner,
  StatCard,
  cn,
  formatRelative,
  toast,
  useResizable,
} from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import {
  useConversation,
  useLinkedTickets,
  type ConversationMessage,
  type MessageAttachment,
} from '../inbox/api.js';
import { useContact, useUpdateContact } from '../contacts/api.js';
import { useAssetBlobUrl } from '../../lib/useAssetBlobUrl.js';
import { downloadAsset } from '../../lib/directus.js';
import { Lightbox } from '../../components/Lightbox.js';
import { LatestOrder } from '../commerce/OrderViews.js';
import { ConversationTags } from './ConversationTags.js';
import { CustomFieldsSection } from '../custom-fields/CustomFieldsSection.js';

interface Props {
  conversationId: string;
  notes?: ConversationMessage[];
  /** Images shared in the thread — rendered as the "Shared media" grid. */
  media?: MessageAttachment[];
  onDeleteNote?: (noteId: string) => void;
  /** Width/utility override. Defaults to the desktop `w-80` rail width. */
  className?: string;
  /** Desktop only: make the panel drag-resizable from its leading edge. */
  resizable?: boolean;
  /** Clicking an order id in the Orders panel raises a complaint about it. The
   *  order is pinned to the conversation before this fires, so the handler only
   *  has to open the Create ticket dialog. */
  onCreateTicketForOrder?: (order: YijiOrder) => void;
}

function MediaThumb({ a, onOpen }: { a: MessageAttachment; onOpen: (url: string) => void }) {
  const { t } = useTranslation();
  const { url, error } = useAssetBlobUrl(a.id, true);
  const [broken, setBroken] = useState(false);
  if (error || broken) return null;
  return (
    <button
      type="button"
      disabled={!url}
      onClick={() => url && onOpen(url)}
      aria-label={t('conversation.previewImage', {
        defaultValue: 'Preview {{name}}',
        name: a.filename ?? 'image',
      })}
      className="group relative aspect-square overflow-hidden rounded-lg bg-secondary transition-[box-shadow] duration-fast ease-out hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {url ? (
        <img
          src={url}
          alt={a.filename ?? ''}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.06]"
        />
      ) : (
        <span className="block h-full w-full animate-pulse bg-secondary" />
      )}
    </button>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  // Board micro-label: uppercase, tracked-out, quiet — matching the tags
  // section header so every sidebar section carries one heading grammar.
  return (
    <h3 className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      <span>{children}</span>
      {/* bg-primary/15, not bg-primary-subtle — that token embeds its own
          alpha so the <alpha-value> expansion is invalid CSS and paints
          nothing (design-law token-alpha trap). Jade-wash pill grammar. */}
      {count !== undefined && count > 0 && (
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums tracking-normal text-primary">
          {count}
        </span>
      )}
    </h3>
  );
}

/** Why the phone cannot be edited, said in a glyph beside the number. */
function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
      aria-hidden
    >
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
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
  media,
  onDeleteNote,
  className,
  resizable,
  onCreateTicketForOrder,
}: Props) {
  const [mediaPreview, setMediaPreview] = useState<{
    url: string;
    a: MessageAttachment;
  } | null>(null);
  const { t } = useTranslation();
  const convo = useConversation(conversationId);
  const tickets = useLinkedTickets(conversationId);
  const navigate = useNavigate();
  const updateContact = useUpdateContact();
  // Pull the contact's Yiji ids (external_customer_id + vendor.yiji_vendor_id) so
  // the agent can retrieve orders without leaving the inbox. Called before the
  // early returns; the query is disabled until a contact id exists.
  const contact = useContact(convo.data?.contact?.id ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '' });
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
  const contactName =
    c.contact?.name ?? c.contact?.phone ?? c.contact?.email ?? t('inbox.unknownContact');

  const startEdit = () => {
    setDraft({
      name: c.contact?.name ?? '',
      email: c.contact?.email ?? '',
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
          /* Never sent. The phone is the identity key and the field above is
             read-only; writing it here anyway would reintroduce the bug the
             moment somebody re-adds an input. */
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
    <aside
      className={cn(
        // One floating profile panel (reference composition): sections are
        // separated by spacing inside a single rounded surface, with a hairline
        // top rule per <section> so the boundaries hold when several quiet
        // sections stack (spacing alone let CONTACT/ORDER/TICKETS blur together).
        'relative shrink-0 overflow-auto rounded-2xl bg-card pb-6 text-foreground shadow-soft ring-1 ring-foreground/[0.06]',
        '[&>section]:border-t [&>section]:border-foreground/[0.06]',
        widthClass,
        className,
      )}
      {...sizeProps}
    >
      {handle}
      {/* Identity hero — avatar in a subtle accent ring. */}
      {/* Compact identity header. The tall centred hero looked good empty but
          pushed the order panel — the thing an agent actually needs mid-call —
          below the fold on a laptop. Horizontal layout reclaims ~90px. */}
      <div className="relative overflow-hidden px-5 pb-4 pt-5">
        <div className="relative flex items-center gap-3 text-start">
          <span className="rounded-full bg-primary/30 p-[2px]">
            <span className="block rounded-full bg-background p-[3px]">
              <Avatar
                name={c.contact?.name}
                email={c.contact?.email}
                phone={c.contact?.phone}
                size="md"
              />
            </span>
          </span>
          <div className="min-w-0 space-y-0.5">
            <h3 className="truncate text-base font-bold tracking-tight text-foreground">
              {contactName}
            </h3>
          </div>
        </div>
      </div>

      {/* Stat tiles — the shared boxed StatCard, two up (the reference
          profile-panel move: Age/Blood, Files/Links). Tickets carries the jade
          accent; media stays neutral. The labels are wrapped in a
          whitespace-normal span: StatCard truncates its label, and at the rail's
          half-width "LINKED TICKETS" became "LINKED TIC…" — wrapping to a second
          line beats amputating the word. */}
      <div className="grid grid-cols-2 gap-2 px-5 pb-2">
        <StatCard
          label={
            <span className="whitespace-normal leading-normal">{t('sidebar.linkedTickets')}</span>
          }
          value={tickets.data?.length ?? 0}
          tone="primary"
        />
        <StatCard
          label={
            <span className="whitespace-normal leading-normal">
              {t('sidebar.sharedMedia', { defaultValue: 'Shared media' })}
            </span>
          }
          value={media?.length ?? 0}
        />
      </div>

      {/* Contact details — name and email are editable so an agent can correct
          what a customer tells them. THE PHONE IS NOT: it is the identity this
          whole product is keyed on. `upsertContact` matches an incoming chat by
          exact phone, the walk-in page opens a session by it, and the contact
          is deduped on it — so editing it does not correct a record, it points
          this conversation's history at a different person and leaves the real
          customer's next message to create a fresh contact. Shown read-only
          below instead, because an agent still needs to read it out. */}
      <section className="px-5 py-4">
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
            {/* Read-only, and visibly so — an agent reads this number back on a
                call, so hiding it while editing would be worse than useless. */}
            {c.contact?.phone && (
              <div className="block">
                <span className="mb-1 block text-muted-foreground">{t('sidebar.phone')}</span>
                <p
                  className="flex items-center gap-1.5 rounded-lg bg-secondary/60 px-3 py-2 text-xs tabular-nums text-muted-foreground ring-1 ring-inset ring-foreground/[0.04]"
                  dir="ltr"
                >
                  <LockIcon />
                  <span>{c.contact.phone}</span>
                </p>
              </div>
            )}
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
          /* Hairline-ruled detail rows — the board's table grammar. */
          <dl className="divide-y divide-foreground/[0.06] text-xs">
            {c.contact?.email && (
              <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground">{t('sidebar.email')}</dt>
                <dd className="truncate font-medium text-foreground">{c.contact.email}</dd>
              </div>
            )}
            {c.contact?.phone && (
              <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground">{t('sidebar.phone')}</dt>
                <dd className="font-medium text-foreground">
                  <Ltr className="tabular-nums">{c.contact.phone}</Ltr>
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* Orders — the customer's latest order (live Yiji data), right in the inbox */}
      {/* Gated on the VENDOR only, not on the contact being linked to a commerce
          customer. The unlinked case is exactly when the agent needs to type an
          order number by hand, so hiding the panel there removed the tool at the
          moment it was needed. */}
      {contact.data?.vendor?.yiji_vendor_id && (
        <section className="px-5 py-4">
          <LatestOrder
            vendorId={contact.data.vendor.yiji_vendor_id}
            customerId={contact.data.external_customer_id ?? undefined}
            conversationId={c.id}
            // Already on screen with the conversation, so the panel has an
            // order to show from the first frame instead of a skeleton.
            stamped={c.last_order_snapshot ?? null}
            onCreateTicket={onCreateTicketForOrder}
          />
        </section>
      )}

      {/* No "earlier chats" panel, and no link standing in for one.
          It listed a status pill and a date per past conversation — five lines
          of "Solved · 23/08/2026", which identify nothing and answer nothing.
          Replacing it with a link to the contact profile was still one more
          thing in a sidebar the agent reads while a customer waits, and the
          owner does not want it there.
          The customer's full history has a home already: Contacts, where the
          profile merges chats AND tickets into one timeline. Nothing was lost
          except a panel that was pretending to be it. */}
      {/* Linked tickets — hairline-ruled rows with hover lift, not stacked cards. */}
      <section className="px-5 py-4">
        <SectionLabel count={tickets.data?.length}>{t('sidebar.linkedTickets')}</SectionLabel>
        {tickets.isLoading ? (
          <Spinner />
        ) : tickets.data && tickets.data.length > 0 ? (
          <ul className="divide-y divide-foreground/[0.06]">
            {tickets.data.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/tickets/${tk.id}`)}
                  title={t('sidebar.openTicket', { defaultValue: 'Open ticket' })}
                  className="block w-full rounded-lg px-1 py-2.5 text-start transition-colors duration-fast ease-out hover:bg-foreground/[0.04]"
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
          /* Composed mini-empty: a dashed placeholder slot, not a bare line
             floating in dead space. */
          <p className="rounded-xl border border-dashed border-border px-3 py-3.5 text-center text-xs text-muted-foreground">
            {t('sidebar.noTickets')}
          </p>
        )}
      </section>

      {/* Tags — the single, interactive home for conversation tags. */}
      <section className="px-5 py-4">
        <ConversationTags conversation={c} />
      </section>

      {/* Shared media — images from the thread, messenger-style grid. */}
      {media && media.length > 0 && (
        <section className="px-5 py-4">
          <SectionLabel count={media.length}>
            {t('sidebar.sharedMedia', { defaultValue: 'Shared media' })}
          </SectionLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {media.slice(0, 9).map((a) => (
              <MediaThumb key={a.id} a={a} onOpen={(url) => setMediaPreview({ url, a })} />
            ))}
          </div>
          {mediaPreview && (
            <Lightbox
              url={mediaPreview.url}
              filename={mediaPreview.a.filename}
              filesize={mediaPreview.a.filesize}
              onDownload={() =>
                void downloadAsset(mediaPreview.a.id, mediaPreview.a.filename ?? undefined).catch(
                  () => undefined,
                )
              }
              onClose={() => setMediaPreview(null)}
            />
          )}
        </section>
      )}

      {/* Custom fields (per-conversation) — card hides when nothing renders. */}
      <section className="px-5 py-4 empty:hidden">
        <CustomFieldsSection entityType="conversation" entityId={conversationId} />
      </section>

      {/* Internal notes — agent-only side conversation. Authored by the team,
          rendered out of the customer thread so they can't bleed in visually.
          Kept last with custom fields: both are agent-side bookkeeping, below
          the customer-facing panels the operations team asked to lead with. */}
      <section className="px-5 py-4">
        <SectionLabel count={notes?.length}>
          {t('sidebar.internalNotes', { defaultValue: 'Internal notes' })}
        </SectionLabel>
        {notes && notes.length > 0 ? (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className="group relative rounded-xl bg-warning/10 px-3 py-2.5 ring-1 ring-warning/20"
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
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-destructive/40 group-hover:opacity-100"
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
          /* Same dashed placeholder-slot grammar as the tickets empty above. */
          <p className="rounded-xl border border-dashed border-border px-3 py-3.5 text-center text-xs text-muted-foreground">
            {t('sidebar.noNotes', { defaultValue: 'No internal notes yet.' })}
          </p>
        )}
      </section>
    </aside>
  );
}
