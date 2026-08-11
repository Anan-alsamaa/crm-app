import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, cn, FormField, Input, Spinner } from '@yiji/ui';
import { useContactSearch, type ContactRow } from '../contacts/api.js';

/**
 * Find the customer a ticket belongs to.
 *
 * Used when there is no conversation to take them from — a complaint that
 * arrived by phone or social. The chosen contact also supplies the vendor id,
 * which is why the whole row is held rather than just an id: the search results
 * that produced it are gone as soon as the term changes.
 *
 * The directory is searched server-side and starts EMPTY. Listing every contact
 * would be unusable at thousands of rows, and phone is the primary lookup here
 * because plenty of contacts have no name.
 */
export function ContactPicker({
  value,
  onChange,
}: {
  value: ContactRow | null;
  onChange: (c: ContactRow | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const tooShort = search.trim().length < 2;
  const contactSearch = useContactSearch(search);
  const matches = contactSearch.data ?? [];

  return (
    <FormField label={t('tickets.contact', { defaultValue: 'Contact' })} htmlFor="ticket-contact">
      {value ? (
        <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-2 ring-1 ring-foreground/[0.05]">
          <Avatar name={value.name} email={value.email} phone={value.phone} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {value.name ?? value.phone ?? value.email ?? value.id}
            </div>
            {(value.phone ?? value.email) && (
              <div className="truncate text-xs text-muted-foreground">
                {value.phone ?? value.email}
              </div>
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
          {tooShort ? (
            <p className="rounded-xl px-3 py-4 text-center text-xs text-muted-foreground ring-1 ring-foreground/[0.05]">
              {t('tickets.contactSearchPrompt', {
                defaultValue: 'Type a phone number or name to find a contact.',
              })}
            </p>
          ) : (
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
                          <div className="truncate text-sm font-medium text-foreground">
                            {c.name ?? c.phone ?? c.email ?? c.id}
                          </div>
                          {(c.phone ?? c.email) && (
                            <div className="truncate text-xs text-muted-foreground">
                              {c.phone ?? c.email}
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
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
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
