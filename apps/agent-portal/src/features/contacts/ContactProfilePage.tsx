import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  formatRelative,
  Input,
  Pill,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useContact,
  useContactConversations,
  useContactTickets,
  useUpdateContact,
  type ContactTimelineConversation,
  type ContactTimelineTicket,
} from './api.js';

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5z" />
    </svg>
  );
}
import { CommercePanel } from './CommercePanel.js';
import { ContactTags } from './ContactTags.js';

/**
 * Contact profile.
 *
 * Two-column layout under a slim toolbar:
 *   - left:  identity + chronological timeline merging conversations + tickets
 *   - right: commerce panel (orders, payment, shipment, lifetime activity)
 *
 * The right panel uses the vendor's `yiji_vendor_id` (not the Directus
 * vendor.id) — that's the identifier the upstream Yiji platform issues.
 */

type TimelineKind = 'conversation' | 'ticket';
interface TimelineItem {
  kind: TimelineKind;
  id: string;
  at: string;
  conv?: ContactTimelineConversation;
  ticket?: ContactTimelineTicket;
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'muted' | 'primary' | 'neutral'> = {
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
  new: 'primary',
};

export function ContactProfilePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const contact = useContact(id);
  const conversations = useContactConversations(id);
  const tickets = useContactTickets(id);
  const updateContact = useUpdateContact();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  // Leave edit mode when navigating to a different contact.
  useEffect(() => setEditing(false), [id]);

  const startEdit = () => {
    const c = contact.data;
    if (!c) return;
    setDraft({ name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '' });
    setEditing(true);
  };
  const saveContact = async () => {
    const c = contact.data;
    if (!c) return;
    try {
      await updateContact.mutateAsync({
        id: c.id,
        patch: {
          name: draft.name.trim() || null,
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
        },
      });
      toast.success(t('contacts.saved', { defaultValue: 'Customer details saved.' }));
      setEditing(false);
    } catch {
      toast.error(t('contacts.saveError', { defaultValue: 'Could not save customer details.' }));
    }
  };

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    for (const c of conversations.data ?? []) {
      items.push({
        kind: 'conversation',
        id: c.id,
        at: c.last_message_at ?? c.date_created ?? '',
        conv: c,
      });
    }
    for (const tk of tickets.data ?? []) {
      items.push({
        kind: 'ticket',
        id: tk.id,
        at: tk.date_created ?? '',
        ticket: tk,
      });
    }
    return items.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [conversations.data, tickets.data]);

  const fullName =
    contact.data?.name ??
    contact.data?.email ??
    t('contacts.unknown', { defaultValue: 'Unknown contact' });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <Link
          to="/contacts"
          className="text-2xs text-muted-foreground hover:text-foreground transition-colors duration-fast ease-out"
        >
          {t('contacts.allContacts', { defaultValue: 'Contacts' })}
        </Link>
        <span className="opacity-30 text-xs text-muted-foreground">›</span>
        <h1 className="text-sm font-semibold tracking-tight text-foreground truncate">
          {contact.isLoading ? <Skeleton className="h-3 w-32 inline-block" /> : fullName}
        </h1>
        <ToolbarSpacer />
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-fast ease-out"
        >
          {t('actions.close', { ns: 'common', defaultValue: 'Close' })}
        </button>
      </Toolbar>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-6 sm:p-10 lg:grid-cols-[1fr_360px]">
          {/* Left column: identity + timeline */}
          <div className="space-y-6">
            {IdentityCard()}
            <TimelineSection
              loading={conversations.isLoading || tickets.isLoading}
              items={timeline}
            />
          </div>

          {/* Right column: tags + commerce panel */}
          <div className="space-y-6">
            {contact.data && <ContactTags contact={contact.data} />}
            <div className="space-y-3">
              <h2 className="px-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t('commerce.title', { defaultValue: 'Commerce' })}
              </h2>
              <CommercePanel
                yijiVendorId={contact.data?.vendor?.yiji_vendor_id ?? ''}
                externalCustomerId={contact.data?.external_customer_id ?? ''}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  function IdentityCard() {
    if (contact.isLoading || !contact.data) {
      return (
        <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] p-6 space-y-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      );
    }
    const c = contact.data;
    const metaTier = (c.metadata?.tier as string | undefined) ?? null;
    return (
      <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] p-6">
        <div className="flex items-start gap-4">
          <Avatar name={c.name} email={c.email} size="lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            {editing ? (
              <div className="space-y-3">
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">
                    {t('contacts.name', { defaultValue: 'Name' })}
                  </span>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t('contacts.unknown', { defaultValue: 'Unknown contact' })}
                    aria-label={t('contacts.name', { defaultValue: 'Name' })}
                  />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">
                      {t('contacts.email', { defaultValue: 'Email' })}
                    </span>
                    <Input
                      type="email"
                      value={draft.email}
                      onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                      aria-label={t('contacts.email', { defaultValue: 'Email' })}
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">
                      {t('contacts.phone', { defaultValue: 'Phone' })}
                    </span>
                    <Input
                      type="tel"
                      value={draft.phone}
                      onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                      aria-label={t('contacts.phone', { defaultValue: 'Phone' })}
                    />
                  </label>
                </div>
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
              <>
                <div className="flex items-baseline gap-2">
                  <h2 className="text-xl font-semibold tracking-tight text-foreground truncate">
                    {c.name ?? c.email}
                  </h2>
                  {metaTier && <Pill tone="primary">{metaTier}</Pill>}
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2">
                  {c.email && (
                    <Row label={t('contacts.email', { defaultValue: 'Email' })} value={c.email} />
                  )}
                  {c.phone && (
                    <Row label={t('contacts.phone', { defaultValue: 'Phone' })} value={c.phone} />
                  )}
                  {c.vendor?.name && (
                    <Row
                      label={t('contacts.vendor', { defaultValue: 'Vendor' })}
                      value={c.vendor.name}
                    />
                  )}
                  {c.external_customer_id && (
                    <Row
                      label={t('contacts.externalId', { defaultValue: 'External ID' })}
                      value={c.external_customer_id}
                    />
                  )}
                </dl>
              </>
            )}
          </div>
          {!editing && (
            <button
              type="button"
              onClick={startEdit}
              aria-label={t('contacts.editContact', { defaultValue: 'Edit contact' })}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <PencilIcon />
            </button>
          )}
        </div>
      </div>
    );
  }

  function TimelineSection({ loading, items }: { loading: boolean; items: TimelineItem[] }) {
    return (
      <section className="space-y-3">
        <h2 className="px-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('contacts.timeline', { defaultValue: 'History' })}
        </h2>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-2xl" />
            <Skeleton className="h-14 w-full rounded-2xl" />
            <Skeleton className="h-14 w-full rounded-2xl" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground/80">
            {t('contacts.noHistory', { defaultValue: 'No conversations or tickets yet.' })}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={`${it.kind}-${it.id}`}>
                {it.kind === 'conversation' && it.conv ? (
                  <TimelineConversationCard conv={it.conv} />
                ) : it.ticket ? (
                  <TimelineTicketCard ticket={it.ticket} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  function TimelineConversationCard({ conv }: { conv: ContactTimelineConversation }) {
    return (
      <Link
        to={`/?conversation=${conv.id}`}
        className={cn(
          'group block rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-4 py-3',
          'transition-[box-shadow,transform,background-color] duration-fast ease-out',
          'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08] hover:-translate-y-px',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <Pill tone={STATUS_TONE[conv.status] ?? 'neutral'} size="sm" dot>
              {t(`status.${conv.status}`, { ns: 'common', defaultValue: conv.status })}
            </Pill>
            <span className="text-sm font-medium text-foreground">
              {t('contacts.conversation', { defaultValue: 'Conversation' })}
            </span>
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {formatRelative(conv.last_message_at ?? conv.date_created)}
          </span>
        </div>
      </Link>
    );
  }

  function TimelineTicketCard({ ticket }: { ticket: ContactTimelineTicket }) {
    return (
      <Link
        to="/tickets"
        className={cn(
          'group block rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-4 py-3',
          'transition-[box-shadow,transform,background-color] duration-fast ease-out',
          'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08] hover:-translate-y-px',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Pill tone={STATUS_TONE[ticket.status] ?? 'neutral'} size="sm" dot>
                {t(`status.${ticket.status}`, { ns: 'common', defaultValue: ticket.status })}
              </Pill>
              <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                {t('contacts.ticket', { defaultValue: 'Ticket' })}
              </span>
            </div>
            <div className="mt-1 text-sm font-medium text-foreground truncate">
              {ticket.subject}
            </div>
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {formatRelative(ticket.date_created)}
          </span>
        </div>
      </Link>
    );
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground truncate">{label}</dt>
      <dd className="text-foreground font-medium truncate">{value}</dd>
    </>
  );
}
