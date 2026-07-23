import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
  UsersIcon,
} from '@yiji/ui';
import { useContacts, type ContactRow } from './api.js';

/**
 * Contacts list — searchable list of every contact across vendors.
 *
 * Search matches name / email / phone / external id case-insensitively.
 * "Export CSV" downloads the currently-filtered set as a UTF-8 CSV (BOM
 * prefix so Excel honours the encoding); generation runs entirely client-
 * side so we never round-trip the data through a worker for what is
 * already a fully-loaded list.
 */

const CSV_HEADER = [
  'id',
  'name',
  'email',
  'phone',
  'external_customer_id',
  'vendor',
  'date_created',
];

function rowToCsv(c: ContactRow): string {
  const cells = [
    c.id,
    c.name ?? '',
    c.email ?? '',
    c.phone ?? '',
    c.external_customer_id ?? '',
    c.vendor?.name ?? '',
    c.date_created ?? '',
  ];
  // RFC 4180: wrap in double quotes, escape internal quotes by doubling.
  return cells.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

function exportCsv(rows: ContactRow[]): void {
  const lines = [CSV_HEADER.join(','), ...rows.map(rowToCsv)];
  // BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ContactsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const contacts = useContacts();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const all = contacts.data ?? [];
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      (c) =>
        (c.name ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q) ||
        (c.external_customer_id ?? '').toLowerCase().includes(q) ||
        (c.vendor?.name ?? '').toLowerCase().includes(q),
    );
  }, [contacts.data, search]);

  const onExport = () => {
    if (filtered.length === 0) {
      toast.warning(t('contacts.exportEmpty', { defaultValue: 'Nothing to export.' }));
      return;
    }
    exportCsv(filtered);
    toast.success(
      t('contacts.exported', {
        count: filtered.length,
        defaultValue: `Exported ${filtered.length} contact${filtered.length === 1 ? '' : 's'}.`,
      }),
    );
  };

  const total = contacts.data?.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('contacts.title', { defaultValue: 'Contacts' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong>{' '}
            {t('contacts.total', { defaultValue: 'total' })}
          </span>
          {filtered.length !== total && (
            <>
              <span className="opacity-30">·</span>
              <span className="tabular-nums">
                <strong className="font-semibold text-foreground">{filtered.length}</strong>{' '}
                {t('contacts.matching', { defaultValue: 'matching' })}
              </span>
            </>
          )}
        </span>
        <ToolbarSpacer />
        <div className="relative w-56">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            aria-label={t('contacts.searchPlaceholder', { defaultValue: 'Search…' })}
            placeholder={t('contacts.searchPlaceholder', { defaultValue: 'Search…' })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block h-8 w-full rounded-md border border-border bg-background/60 ps-8 pe-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start transition-colors duration-fast ease-out"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onExport}>
          {t('contacts.exportCsv', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {contacts.isLoading ? (
          <ul className="mx-auto max-w-5xl divide-y divide-border">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-28" />
                </div>
                <Skeleton className="hidden h-2.5 w-24 sm:block" />
              </li>
            ))}
          </ul>
        ) : total === 0 ? (
          <EmptyState
            icon={<UsersIcon size={40} />}
            title={t('contacts.empty', { defaultValue: 'No contacts yet.' })}
            description={t('contacts.emptyHint', {
              defaultValue:
                'Contacts appear automatically as customers reach out through your channels.',
            })}
          />
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t('contacts.noMatch', { defaultValue: 'No contacts match your search.' })}
          </p>
        ) : (
          <ul className="mx-auto max-w-5xl divide-y divide-border">
            {filtered.map((c) => {
              const name = c.name ?? c.email ?? c.phone ?? c.external_customer_id ?? '—';
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/contacts/${c.id}`)}
                    className={cn(
                      'group flex w-full items-center gap-3 px-4 py-2.5 text-start',
                      'transition-colors duration-fast ease-out hover:bg-secondary/50',
                      'focus-visible:outline-none focus-visible:bg-secondary/60',
                    )}
                  >
                    <Avatar
                      name={c.name}
                      email={c.email}
                      phone={c.phone}
                      size="sm"
                      className="shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{name}</div>
                      {c.email && (
                        <div className="truncate text-xs text-muted-foreground">{c.email}</div>
                      )}
                    </div>
                    {c.phone && (
                      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
                        {c.phone}
                      </span>
                    )}
                    <span
                      title={c.vendor?.name ?? ''}
                      className="hidden w-32 shrink-0 truncate text-end text-xs text-muted-foreground sm:block"
                    >
                      {c.vendor?.name ?? '—'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
