import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  SearchIcon,
  Skeleton,
  StoreIcon,
  toast,
  Toolbar,
  ToolbarSpacer,
  UsersIcon,
} from '@yiji/ui';
import { useContacts, type ContactRow } from './api.js';
import { exportFileName } from '@yiji/shared-config';

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
  a.download = exportFileName('Contacts');
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

  const all = contacts.data ?? [];
  const total = all.length;
  const withEmail = all.filter((c) => !!c.email).length;
  const withPhone = all.filter((c) => !!c.phone).length;
  const withVendor = all.filter((c) => !!c.vendor).length;

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
            className="block h-8 w-full rounded-lg bg-input ps-8 pe-3 text-xs text-foreground placeholder:text-muted-foreground/60 ring-1 ring-inset ring-foreground/[0.08] hover:ring-foreground/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 text-start transition-[box-shadow,background-color] duration-fast ease-out"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onExport}>
          {t('contacts.exportCsv', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {!contacts.isLoading && total > 0 && (
          <div
            className="mx-auto mb-5 grid max-w-5xl grid-cols-2 gap-3 lg:grid-cols-4"
            role="list"
            aria-label={t('contacts.title', { defaultValue: 'Contacts' })}
          >
            <StatTile
              icon={<UsersIcon size={18} />}
              chip="bg-primary-tint text-primary"
              label={t('contacts.total', { defaultValue: 'total' })}
              value={total}
            />
            <StatTile
              icon={<MailGlyph />}
              chip="bg-sky-tint text-sky"
              label={t('contacts.withEmail', { defaultValue: 'with email' })}
              value={withEmail}
            />
            <StatTile
              icon={<PhoneGlyph />}
              chip="bg-success-tint text-success"
              label={t('contacts.withPhone', { defaultValue: 'with phone' })}
              value={withPhone}
            />
            <StatTile
              icon={<StoreIcon size={18} />}
              chip="bg-violet-tint text-violet"
              label={t('contacts.withVendor', { defaultValue: 'linked vendor' })}
              value={withVendor}
            />
          </div>
        )}
        {contacts.isLoading ? (
          <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
            <ul className="divide-y divide-foreground/[0.06]">
              {Array.from({ length: 8 }).map((_, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  {/* h-9 w-9 — the md Avatar the real rows render, so the list
                      doesn't shift when data lands. */}
                  <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-2.5 w-28" />
                  </div>
                  <Skeleton className="hidden h-2.5 w-24 sm:block" />
                </li>
              ))}
            </ul>
          </div>
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
          // Composed empty state, not a bare line adrift on the canvas — the
          // same card surface the list uses, so the page keeps its shape.
          <div className="mx-auto max-w-5xl rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
            <EmptyState
              icon={<SearchIcon size={24} />}
              title={t('contacts.noMatch', { defaultValue: 'No contacts match your search.' })}
            />
          </div>
        ) : (
          // The board list surface: one elevated card, micro-label column
          // headers, hairline row separators, and a footer aggregate band —
          // not loose hover rows on the canvas.
          <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
            <div className="hidden border-b border-foreground/[0.08] bg-foreground/[0.02] px-4 py-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:grid sm:grid-cols-[auto_minmax(0,1fr)_8.5rem_9rem] sm:items-center sm:gap-3">
              <span aria-hidden className="w-9" />
              <span>{t('contacts.name', { defaultValue: 'Name' })}</span>
              <span className="text-end">{t('contacts.phone', { defaultValue: 'Phone' })}</span>
              <span className="text-end">{t('contacts.vendor', { defaultValue: 'Vendor' })}</span>
            </div>
            <ul className="divide-y divide-foreground/[0.06]">
              {filtered.map((c) => {
                const name = c.name ?? c.email ?? c.phone ?? c.external_customer_id ?? '—';
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/contacts/${c.id}`)}
                      // Fixed columns (avatar | identity | phone | vendor) so the
                      // end-aligned cells line up down the list like table columns.
                      className={cn(
                        'group grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-start',
                        'sm:grid-cols-[auto_minmax(0,1fr)_8.5rem_9rem]',
                        'transition-colors duration-fast ease-out hover:bg-primary/[0.07]',
                        'focus-visible:outline-none focus-visible:bg-secondary/60',
                      )}
                    >
                      <Avatar
                        name={c.name}
                        email={c.email}
                        phone={c.phone}
                        size="md"
                        className="shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{name}</div>
                        {c.email && (
                          <div className="truncate text-xs text-muted-foreground">{c.email}</div>
                        )}
                      </div>
                      <span className="hidden truncate text-end text-xs tabular-nums text-muted-foreground sm:block">
                        {c.phone ?? '—'}
                      </span>
                      <span className="hidden min-w-0 justify-self-end sm:block">
                        {c.vendor?.name ? (
                          <span
                            title={c.vendor.name}
                            className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-2xs font-medium text-foreground ring-1 ring-inset ring-foreground/[0.06]"
                          >
                            <span className="truncate">{c.vendor.name}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <footer className="flex h-11 items-center gap-6 border-t border-foreground/[0.08] bg-foreground/[0.02] px-4 text-xs text-muted-foreground">
              <span className="tabular-nums">
                <strong className="font-semibold text-foreground">{filtered.length}</strong>{' '}
                {filtered.length === total
                  ? t('contacts.total', { defaultValue: 'total' })
                  : t('contacts.matching', { defaultValue: 'matching' })}
              </span>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

/** Board stat tile: tinted rounded-square icon chip, extrabold tabular numeral,
    uppercase micro-label. The hue lives on the chip so the numeral stays in
    foreground ink on both themes. */
function StatTile({
  icon,
  chip,
  label,
  value,
}: {
  icon: ReactNode;
  /** Tint + hue token pair for the icon chip, e.g. `bg-sky-tint text-sky`. */
  chip: string;
  label: string;
  value: number;
}) {
  return (
    <div
      role="listitem"
      className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3.5 shadow-soft ring-1 ring-foreground/[0.06]"
    >
      <span aria-hidden className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', chip)}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
          {value}
        </div>
        <div className="mt-1.5 truncate text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </div>
      </div>
    </div>
  );
}

// Local glyphs the shared icon set doesn't carry — same 16-grid stroke anatomy
// as the kit icons so they sit level inside the chips.
function MailGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
      <path d="m2.5 4.5 5.5 4.25L13.5 4.5" />
    </svg>
  );
}
function PhoneGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden
    >
      <path d="M3.1 1.9h2.6l1.2 3-1.6 1.2a9.4 9.4 0 0 0 4.6 4.6l1.2-1.6 3 1.2v2.6a1.3 1.3 0 0 1-1.4 1.3A12.6 12.6 0 0 1 1.8 3.3a1.3 1.3 0 0 1 1.3-1.4Z" />
    </svg>
  );
}
