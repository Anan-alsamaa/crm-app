import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  FormField,
  Input,
  SelectMenu,
  Spinner,
  Textarea,
  cn,
  toast,
} from '@yiji/ui';
import type { Priority } from '@yiji/shared-types';
import { useCreateTicket } from './api.js';
import { useContacts } from '../contacts/api.js';
import { useAgents } from '../inbox/api.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

interface Props {
  onClose: () => void;
  /** Called with the new ticket id so the page can select it. */
  onCreated?: (id: string) => void;
}

/**
 * Standalone "New ticket" flow launched from the Tickets page (no originating
 * conversation). The agent first picks a contact — that contact supplies the
 * `vendor` id required to create the ticket — then fills in the details.
 * Mirrors CreateTicketDialog's overlay/scale-in/focus styling.
 */
export function NewTicketDialog({ onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const createTicket = useCreateTicket();
  const contacts = useContacts();
  const agents = useAgents();

  const [search, setSearch] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assignedAgent, setAssignedAgent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = contacts.data ?? [];
  const selectedContact = useMemo(
    () => list.find((c) => c.id === contactId) ?? null,
    [list, contactId],
  );

  // Filter the contact list by name/email/phone — same fields the inbox search
  // covers. Capped so a large directory stays responsive in the picker.
  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    const base = s
      ? list.filter((c) => [c.name, c.email, c.phone].some((v) => v?.toLowerCase().includes(s)))
      : list;
    return base.slice(0, 50);
  }, [list, search]);

  const vendorId = selectedContact?.vendor?.id ?? null;
  const canSubmit = !!subject.trim() && !!contactId && !!vendorId && !submitting;

  const submit = async () => {
    if (!subject.trim() || !contactId || !vendorId) return;
    setSubmitting(true);
    try {
      const created = (await createTicket.mutateAsync({
        subject: subject.trim(),
        description: description.trim() || undefined,
        priority,
        contact: contactId,
        vendor: vendorId,
        assigned_agent: assignedAgent || null,
      } as Parameters<typeof createTicket.mutateAsync>[0])) as { id?: string } | undefined;
      toast.success(t('tickets.created', { defaultValue: 'Ticket created' }), {
        description: subject.trim(),
      });
      if (created?.id) onCreated?.(created.id);
      onClose();
    } catch {
      toast.error(t('tickets.createError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-3xl bg-card p-7 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in">
        <div className="mb-6 space-y-1.5">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
            {t('tickets.newTitle', { defaultValue: 'New ticket' })}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('tickets.newHint', {
              defaultValue: 'Pick the customer this ticket is for, then describe the work.',
            })}
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-5"
          noValidate
        >
          {/* Contact picker — searchable. The chosen contact supplies the vendor id. */}
          <FormField
            label={t('tickets.contact', { defaultValue: 'Contact' })}
            htmlFor="ticket-contact-search"
          >
            {selectedContact ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-2 ring-1 ring-foreground/[0.05]">
                <Avatar name={selectedContact.name} email={selectedContact.email} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {selectedContact.name ?? selectedContact.email ?? selectedContact.id}
                  </div>
                  {selectedContact.email && (
                    <div className="truncate text-xs text-muted-foreground">
                      {selectedContact.email}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setContactId(null);
                    setSearch('');
                  }}
                >
                  {t('actions.change', { ns: 'common', defaultValue: 'Change' })}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  id="ticket-contact-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('tickets.contactSearch', {
                    defaultValue: 'Search contacts by name, email, or phone…',
                  })}
                  autoComplete="off"
                />
                <div className="max-h-52 overflow-auto rounded-xl ring-1 ring-foreground/[0.05]">
                  {contacts.isLoading ? (
                    <div className="flex items-center justify-center py-6 text-muted-foreground">
                      <Spinner size={16} />
                    </div>
                  ) : matches.length > 0 ? (
                    <ul className="divide-y divide-foreground/[0.04]">
                      {matches.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => setContactId(c.id)}
                            className={cn(
                              'flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors duration-fast ease-out hover:bg-secondary',
                              !c.vendor && 'opacity-60',
                            )}
                          >
                            <Avatar name={c.name} email={c.email} size="sm" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">
                                {c.name ?? c.email ?? c.id}
                              </div>
                              {c.email && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {c.email}
                                </div>
                              )}
                            </div>
                            {!c.vendor && (
                              <span className="shrink-0 text-2xs text-muted-foreground">
                                {t('tickets.noVendor', { defaultValue: 'No vendor' })}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {t('tickets.noContacts', { defaultValue: 'No matching contacts.' })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </FormField>

          <FormField label={t('tickets.subject')} htmlFor="ticket-subject">
            <Input
              id="ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </FormField>

          <FormField label={t('tickets.description')} htmlFor="ticket-description">
            <Textarea
              id="ticket-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>

          <FormField label={t('conversation.priority')} htmlFor="ticket-priority">
            <SelectMenu
              fullWidth
              value={priority}
              onChange={(v) => setPriority(v as Priority)}
              aria-label={t('conversation.priority')}
              options={PRIORITIES.map((p) => ({
                value: p,
                label: t(`priority.${p}`, { ns: 'common' }),
              }))}
            />
          </FormField>

          <FormField label={t('conversation.agent')} htmlFor="ticket-agent">
            <SelectMenu
              fullWidth
              value={assignedAgent}
              onChange={(v) => setAssignedAgent(v)}
              aria-label={t('conversation.agent')}
              options={[
                { value: '', label: t('conversation.unassigned') },
                ...(agents.data ?? []).map((a) => ({
                  value: a.id,
                  label: a.first_name ?? a.email ?? '',
                })),
              ]}
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" size="md" loading={submitting} disabled={!canSubmit}>
              {t('tickets.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
