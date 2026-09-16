import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, cn, FormField, Input, Spinner, Ltr } from '@yiji/ui';
import { formatPhone, isDialablePhone, normalizePhone } from '@yiji/shared-types';
import { useContactSearch, useCreateContact, type ContactRow } from '../contacts/api.js';

/**
 * WHO IS THIS TICKET ABOUT? One field, one answer.
 *
 * Used when there is no conversation to take the customer from — a complaint
 * that arrived by phone, at a counter, or over social. The chosen contact also
 * supplies the vendor id, which is why the whole row is held rather than just
 * an id: the search results that produced it are gone as soon as the term
 * changes.
 *
 * THE AGENT TYPES A PHONE NUMBER OR A NAME, and this resolves it:
 *
 *   matches a contact      -> pick them; the ticket links to their record
 *   no match, a number     -> offer to record them, creating the contact
 *   no match, a name       -> nothing to do; a person needs a number
 *
 * It used to be TWO fields — this picker, plus a separate "Customer phone
 * number" box for walk-ins who had no contacts row. They were never both in
 * play, and the agent had to work out which box was theirs before they could
 * file anything (owner, 2026-09-16). One field asks one question, and the
 * stranger stops being a dead end: the number is the thing an agent always
 * has, whatever the service type.
 *
 * The directory is searched server-side and starts EMPTY. Listing every contact
 * would be unusable at thousands of rows, and phone is the primary lookup here
 * because plenty of contacts have no name.
 */
export function ContactPicker({
  value,
  onChange,
  vendorId,
}: {
  value: ContactRow | null;
  onChange: (c: ContactRow | null) => void;
  /**
   * The vendor a newly created customer belongs to. A contact with no vendor
   * cannot carry a ticket, so without this the create affordance stays hidden
   * rather than making a row that would fail at save.
   */
  vendorId?: string | null;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const tooShort = search.trim().length < 2;
  const contactSearch = useContactSearch(search);
  const matches = contactSearch.data ?? [];
  const createContact = useCreateContact();

  /*
   * THE CUSTOMER WE HAVE NOT MET.
   *
   * Offered only once the search has actually come back empty — never while it
   * is still running, or the button flickers under the agent's cursor as they
   * type and they create somebody by accident. `isDialablePhone` is what keeps
   * a half-typed `05012`, or a name that found nobody, from becoming a row.
   */
  const typed = search.trim();
  const canCreate =
    !!vendorId &&
    !tooShort &&
    !contactSearch.isFetching &&
    matches.length === 0 &&
    isDialablePhone(typed);

  const create = async () => {
    if (!canCreate || !vendorId || createContact.isPending) return;
    const created = await createContact.mutateAsync({ phone: typed, vendor: vendorId });
    // Select them straight away: the agent asked for this customer, so making
    // them search again for the row they just created would be theatre.
    onChange(created);
    setSearch('');
  };

  return (
    <FormField
      label={t('tickets.contact', { defaultValue: 'Contact' })}
      htmlFor="ticket-contact"
      // A one-line hint rather than a boxed placeholder panel. The box said the
      // same thing at four times the height, and on the Add ticket page that
      // pushed the last field below the fold.
      hint={
        !value && tooShort
          ? t('tickets.contactSearchPrompt', {
              defaultValue: 'Type a phone number or name to find a contact.',
            })
          : undefined
      }
    >
      {value ? (
        <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-2 ring-1 ring-foreground/[0.05]">
          <Avatar name={value.name} email={value.email} phone={value.phone} size="sm" />
          <div className="min-w-0 flex-1">
            <div dir="auto" className="truncate text-sm font-medium text-foreground">
              {value.name ?? value.phone ?? value.email ?? value.id}
            </div>
            {(value.phone ?? value.email) && (
              <Ltr as="div" className="truncate text-xs text-muted-foreground">
                {value.phone ?? value.email}
              </Ltr>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(null);
              setSearch('');
            }}
          >
            {t('actions.change', { ns: 'common', defaultValue: 'Change' })}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            id="ticket-contact"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tickets.contactSearch', {
              defaultValue: 'Search by phone number, name, or email…',
            })}
            autoComplete="off"
            inputMode="tel"
          />
          {tooShort ? null : (
            <div className="max-h-44 overflow-auto rounded-xl ring-1 ring-foreground/[0.05]">
              {contactSearch.isFetching ? (
                <div className="flex items-center justify-center py-5 text-muted-foreground">
                  <Spinner size={16} />
                </div>
              ) : matches.length > 0 ? (
                <ul className="divide-y divide-foreground/[0.04]">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onChange(c)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors duration-fast ease-out hover:bg-secondary',
                          // A contact with no vendor cannot carry a ticket, so it
                          // is shown but visibly weaker rather than hidden — the
                          // agent searched for it and needs to know it was found.
                          !c.vendor && 'opacity-60',
                        )}
                      >
                        <Avatar name={c.name} email={c.email} phone={c.phone} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div dir="auto" className="truncate text-sm font-medium text-foreground">
                            {c.name ?? c.phone ?? c.email ?? c.id}
                          </div>
                          {(c.phone ?? c.email) && (
                            <Ltr as="div" className="truncate text-xs text-muted-foreground">
                              {c.phone ?? c.email}
                            </Ltr>
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
              ) : canCreate ? (
                /*
                 * The empty result that is not a dead end. This number belongs
                 * to somebody the CRM has never seen, which is most walk-ins —
                 * so say so, and let the agent record them in one action
                 * instead of abandoning the ticket.
                 */
                <div className="space-y-2.5 px-3 py-4 text-center">
                  <p className="text-xs text-muted-foreground">
                    {t('tickets.noContactsForNumber', {
                      defaultValue: 'Nobody in the CRM has this number.',
                    })}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void create()}
                    disabled={createContact.isPending}
                  >
                    {createContact.isPending ? (
                      <Spinner size={14} />
                    ) : (
                      t('tickets.addCustomerWithNumber', {
                        defaultValue: 'Add {{phone}} as a new customer',
                        phone: formatPhone(normalizePhone(typed) || typed),
                      })
                    )}
                  </Button>
                  {createContact.isError && (
                    <p className="text-xs text-destructive">
                      {t('tickets.addCustomerFailed', {
                        defaultValue: 'Could not add the customer. Please try again.',
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                  {/* A name that found nobody, or a number still being typed.
                      Neither can become a customer: a person needs a number. */}
                  {t('tickets.noContacts', { defaultValue: 'No matching contacts.' })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </FormField>
  );
}
