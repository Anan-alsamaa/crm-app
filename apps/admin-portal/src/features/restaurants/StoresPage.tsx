import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  ConfirmDialog,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Pill,
  Select,
  Skeleton,
  StatStrip,
  toast,
  Toolbar,
  Pagination,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useStores,
  useBrands,
  useCreateStore,
  useUpdateStore,
  useDeleteStore,
  useBulkCreateStores,
  useBulkCreateBrands,
  type Store,
} from './api.js';
import { downloadCsv, parseStoresCsv, toCsv } from './csv.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { exportFileName } from '@yiji/shared-config';

const schema = z.object({
  code: z.string().optional(),
  name: z.string().min(1),
  city: z.string().optional(),
  area_manager: z.string().optional(),
  chain_manager: z.string().optional(),
  yiji_restaurant_id: z.string().optional(),
  brand: z.string().optional(),
  status: z.enum(['active', 'inactive']),
});
type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  code: '',
  name: '',
  city: '',
  area_manager: '',
  chain_manager: '',
  yiji_restaurant_id: '',
  brand: '',
  status: 'active',
};

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M8 11V3M5 6l3-3 3 3M3 11v2h10v-2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M8 3v8M5 8l3 3 3-3M3 13h10" />
    </svg>
  );
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

const PAGE_SIZE = 25;

export function StoresPage() {
  const { t } = useTranslation();
  // Only the Administrator may set the Yiji restaurant id. `admin_access` is
  // the authoritative Directus signal (the built-in Administrator has it; the
  // CRM "Admin" role does not) — a role-NAME check would be spoofable by
  // creating a role called "Administrator". This only hides the control; the
  // real enforcement is the field-scoped permission in roles.ts.
  const { user } = useAuth();
  const canEditYijiId = !!user?.admin_access;
  const stores = useStores();
  const brands = useBrands();
  const createStore = useCreateStore();
  const updateStore = useUpdateStore();
  const deleteStore = useDeleteStore();
  const bulkStores = useBulkCreateStores();
  const bulkBrands = useBulkCreateBrands();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Store | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Store | null>(null);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const openCreate = () => {
    setEditing(null);
    reset(EMPTY);
    setOpen(true);
  };

  const openEdit = (s: Store) => {
    setEditing(s);
    reset({
      code: s.code ?? '',
      name: s.name,
      city: s.city ?? '',
      area_manager: s.area_manager ?? '',
      chain_manager: s.chain_manager ?? '',
      yiji_restaurant_id: s.yiji_restaurant_id ?? '',
      brand: s.brand?.id ?? '',
      status: s.status,
    });
    setOpen(true);
  };

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      code: blank(values.code),
      name: values.name.trim(),
      city: blank(values.city),
      area_manager: blank(values.area_manager),
      chain_manager: blank(values.chain_manager),
      yiji_restaurant_id: blank(values.yiji_restaurant_id),
      brand: blank(values.brand),
      status: values.status,
    };
    try {
      if (editing) {
        await updateStore.mutateAsync({ id: editing.id, ...payload });
        toast.success(t('stores.updated', { defaultValue: 'Store updated.' }));
      } else {
        await createStore.mutateAsync(payload);
        toast.success(t('stores.created', { defaultValue: 'Store created.' }));
      }
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('stores.saveError', { defaultValue: 'Could not save the store.' }));
    }
  });

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteStore.mutateAsync(confirmDelete.id);
      toast.success(t('stores.deleted', { defaultValue: 'Store deleted.' }));
    } catch {
      toast.error(t('stores.deleteError', { defaultValue: 'Could not delete the store.' }));
    } finally {
      setConfirmDelete(null);
    }
  };

  /**
   * Onboard stores from an uploaded sheet — both for the initial load and,
   * later, for a branch that has just opened. Only rows the portal does not
   * already have are added; the rest are counted and left alone.
   *
   * Brands referenced by the file but not yet in the system are created first,
   * so a new brand's first branch can be onboarded from the one file without
   * hand-creating the brand beforehand.
   */
  const onFile = async (file: File) => {
    setImporting(true);
    try {
      const parsed = parseStoresCsv(await file.text());
      if (parsed.rows.length === 0) {
        toast.error(
          t('stores.importEmpty', {
            defaultValue: 'No usable rows found — expected a Restaurant column.',
          }),
        );
        return;
      }

      const existingBrands = brands.data ?? [];
      const brandIdByKey = new Map(existingBrands.map((b) => [b.code.trim().toLowerCase(), b.id]));
      const wanted = Array.from(
        new Set(parsed.rows.map((r) => r.brandCode).filter((c): c is string => !!c)),
      );
      // Hand the hook every brand the sheet references, not just the ones this
      // (possibly stale) cache thinks are missing — it re-reads and skips the
      // ones that already exist. Filtering here as well would only decide from
      // older data than the hook has.
      const brandResult = await bulkBrands.mutateAsync(
        wanted.map((code) => ({ code: code.trim(), name: code.trim(), status: 'active' as const })),
      );
      // Refresh when brands were created OR when this cache simply does not
      // know a brand the sheet needs. "Already present" means the row exists in
      // Directus, NOT that its id is in this cache — and without the id the
      // store is imported with no brand at all, which looks like a data problem
      // rather than a stale cache and silently breaks brand-level reporting.
      const unresolved = wanted.some((c) => !brandIdByKey.has(c.trim().toLowerCase()));
      if (brandResult.added > 0 || unresolved) {
        const refreshed = await brands.refetch();
        for (const b of refreshed.data ?? []) brandIdByKey.set(b.code.trim().toLowerCase(), b.id);
      }

      const storeResult = await bulkStores.mutateAsync(
        parsed.rows.map((r) => ({
          code: r.code,
          name: r.name,
          city: r.city,
          area_manager: r.areaManager,
          chain_manager: r.chainManager,
          // Omit the field entirely for anyone but the Administrator. Sending
          // it — even as null — is rejected by the field-scoped permission and
          // would fail the whole import rather than just that column.
          ...(canEditYijiId ? { yiji_restaurant_id: r.yijiRestaurantId } : {}),
          brand: r.brandCode ? (brandIdByKey.get(r.brandCode.trim().toLowerCase()) ?? null) : null,
          // Matching only — stripped before the insert. Lets a codeless row be
          // told apart from a same-named branch of a different brand.
          brand_code: r.brandCode,
          status: 'active' as const,
        })),
      );

      // Report what was DROPPED as loudly as what landed — a silent skip in an
      // import is how a store goes missing from every later report. "Already
      // present" is stated even when it is the whole file, so re-running the
      // same upload reads as a no-op rather than as a failure.
      // Three counts, never merged: "updated" is the one that says the sheet
      // CHANGED existing branches, and folding it into either of the others
      // would hide an edit to live master data behind a reassuring number.
      const bits = [
        t('stores.importAdded', { defaultValue: '{{n}} added', n: storeResult.added }),
        t('stores.importUpdated', { defaultValue: '{{n}} updated', n: storeResult.updated }),
        t('stores.importExisting', {
          defaultValue: '{{n}} unchanged',
          n: storeResult.alreadyPresent,
        }),
      ];
      if (brandResult.added)
        bits.push(
          t('stores.importBrands', { defaultValue: '{{n}} brands created', n: brandResult.added }),
        );
      if (parsed.skipped.length)
        bits.push(
          t('stores.importSkipped', {
            defaultValue: '{{n}} rows skipped (no name)',
            n: parsed.skipped.length,
          }),
        );
      if (parsed.unmappedHeaders.length)
        bits.push(
          t('stores.importUnknownCols', {
            defaultValue: 'ignored columns: {{cols}}',
            cols: parsed.unmappedHeaders.join(', '),
          }),
        );
      toast.success(bits.join(' · '));
    } catch {
      toast.error(t('stores.importError', { defaultValue: 'Import failed.' }));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const list = stores.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [
        s.yiji_restaurant_id,
        s.code,
        s.name,
        s.city,
        s.area_manager,
        s.chain_manager,
        s.brand?.name,
        s.brand?.code,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [list, query]);

  /* Long lists page rather than scroll: the same control the ticket report
     uses, so every table in the product behaves the same way. */
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const paged = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const exportCsv = () => {
    const header = [
      t('stores.colRestaurantId', { defaultValue: 'Restaurant ID' }),
      t('stores.colCode', { defaultValue: 'Code' }),
      t('stores.colName', { defaultValue: 'Store' }),
      t('stores.colBrand', { defaultValue: 'Brand' }),
      t('stores.colCity', { defaultValue: 'City' }),
      t('stores.colAreaManager', { defaultValue: 'Area manager' }),
      t('stores.colChainManager', { defaultValue: 'Chain manager' }),
      t('stores.colStatus', { defaultValue: 'Status' }),
    ];
    const rows = filtered.map((s) => [
      s.yiji_restaurant_id,
      s.code,
      s.name,
      s.brand?.name,
      s.city,
      s.area_manager,
      s.chain_manager,
      t(`status.${s.status}`, { ns: 'common', defaultValue: s.status }),
    ]);
    downloadCsv(
      exportFileName('Stores', { scope: query.trim() ? `matching ${query.trim()}` : 'all' }),
      toCsv(header, rows),
    );
  };

  const cities = new Set(list.map((s) => s.city).filter(Boolean));
  const unmapped = list.filter((s) => !s.brand).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('stores.title', { defaultValue: 'Stores' })}
        </h1>
        <ToolbarSpacer />
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.tsv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={importing}
          onClick={() => fileRef.current?.click()}
          iconStart={<UploadIcon />}
        >
          {t('stores.import', { defaultValue: 'Import CSV' })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={filtered.length === 0}
          onClick={exportCsv}
          iconStart={<DownloadIcon />}
        >
          {t('stores.export', { defaultValue: 'Export CSV' })}
        </Button>
        <Button type="button" size="sm" onClick={openCreate} iconStart={<PlusIcon />}>
          {t('stores.create', { defaultValue: 'Add store' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {!stores.isLoading && !stores.isError && list.length > 0 && (
          <div className="mx-auto mb-5 max-w-6xl space-y-5">
            <div className=" pb-5">
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('stores.heroSubtitle', {
                  defaultValue:
                    'Every branch you operate, with its brand, city and managers. Ticket reports and dashboards join orders onto these rows.',
                })}
              </p>
            </div>
            <StatStrip
              items={[
                {
                  label: t('stores.total', { defaultValue: 'stores' }),
                  value: list.length,
                  tone: 'blue',
                },
                {
                  label: t('stores.cities', { defaultValue: 'cities' }),
                  value: cities.size,
                  tone: 'violet',
                },
                {
                  label: t('stores.brandsUnit', { defaultValue: 'brands' }),
                  value: brands.data?.length ?? 0,
                  tone: 'green',
                },
                {
                  label: t('stores.noBrand', { defaultValue: 'without a brand' }),
                  value: unmapped,
                  tone: unmapped > 0 ? 'amber' : 'neutral',
                },
              ]}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('stores.search', {
                defaultValue: 'Search store, code, city, brand or manager…',
              })}
            />
          </div>
        )}

        {stores.isError ? (
          <ErrorState
            title={t('stores.loadError', { defaultValue: 'Could not load stores' })}
            message={t('stores.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void stores.refetch()}
          />
        ) : stores.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-3">
                <Skeleton className="h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-2.5 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            title={t('stores.empty', { defaultValue: 'No stores yet' })}
            description={t('stores.emptyHint', {
              defaultValue:
                'Import your store sheet as CSV, or add branches one at a time. Columns: Restaurant, Area Manager, Chain Manager, Brand, City.',
            })}
            action={
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  iconStart={<UploadIcon />}
                >
                  {t('stores.import', { defaultValue: 'Import CSV' })}
                </Button>
                <Button type="button" variant="ghost" onClick={openCreate} iconStart={<PlusIcon />}>
                  {t('stores.create', { defaultValue: 'Add store' })}
                </Button>
              </div>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={t('stores.noMatches', { defaultValue: 'No stores match that search' })}
            description={t('stores.noMatchesHint', { defaultValue: 'Try a different term.' })}
          />
        ) : (
          /* Board table — raised micro-label header band, hairline rows, a
             footer aggregate band. overflow-x-auto stays on the card so wide
             registers scroll inside it, never the page. */
          <div className="mx-auto max-w-6xl overflow-x-auto rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
              <thead>
                <tr className="tracking-[0.12em] bg-secondary/70 text-2xs uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]">
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colRestaurantId', { defaultValue: 'Restaurant ID' })}
                  </th>
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colStore', { defaultValue: 'Store' })}
                  </th>
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colBrand', { defaultValue: 'Brand' })}
                  </th>
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colCity', { defaultValue: 'City' })}
                  </th>
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colArea', { defaultValue: 'Area manager' })}
                  </th>
                  <th className="h-11 whitespace-nowrap px-4 text-start align-middle font-semibold">
                    {t('stores.colChain', { defaultValue: 'Chain manager' })}
                  </th>
                  <th className="h-11 px-4 text-end align-middle font-semibold" />
                </tr>
              </thead>
              <tbody>
                {paged.map((s) => (
                  <tr
                    key={s.id}
                    className={cn(
                      'border-t border-foreground/[0.06] transition-colors duration-fast',
                      // The board's accent-tinted hover wash, not a grey one.
                      'hover:bg-primary/[0.07]',
                    )}
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      {s.yiji_restaurant_id ? (
                        <span className="font-mono text-xs tabular-nums text-foreground">
                          {s.yiji_restaurant_id}
                        </span>
                      ) : (
                        // Blank, not "0" or "—" in the same weight as a real id:
                        // an unmapped store must not read as a mapped one at a glance.
                        <span className="font-mono text-xs text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        className="text-start focus-visible:outline-none"
                      >
                        <span className="font-medium text-foreground">{s.name}</span>
                        {s.code && (
                          <span className="ms-2 text-2xs text-muted-foreground tabular-nums">
                            {s.code}
                          </span>
                        )}
                        {s.status === 'inactive' && (
                          <span className="ms-2">
                            <Pill tone="muted" size="sm">
                              {t('stores.inactive', { defaultValue: 'Inactive' })}
                            </Pill>
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {s.brand ? (
                        <span className="text-foreground">{s.brand.name}</span>
                      ) : (
                        <Pill tone="warning" size="sm">
                          {t('stores.noBrandPill', { defaultValue: 'No brand' })}
                        </Pill>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{s.city ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.area_manager ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.chain_manager ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(s)}>
                        {t('actions.edit', { ns: 'common', defaultValue: 'Edit' })}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(s)}
                      >
                        {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Footer aggregate band — the board table's closing line. Counts
                describe the rows on screen, so a search never mixes scopes. */}
            <div className="flex h-11 items-center gap-6 border-t border-foreground/[0.08] bg-foreground/[0.02] px-4 text-xs text-muted-foreground">
              <span>
                <span className="font-semibold tabular-nums text-foreground">
                  {filtered.length}
                </span>{' '}
                {t('stores.total', { defaultValue: 'stores' })}
              </span>
              {filtered.some((s) => !s.brand) && (
                <span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {filtered.filter((s) => !s.brand).length}
                  </span>{' '}
                  {t('stores.noBrand', { defaultValue: 'without a brand' })}
                </span>
              )}
            </div>
            {pageCount > 1 && (
              <div className="border-t border-foreground/[0.08] px-2 py-1.5">
                <Pagination
                  page={current}
                  pageCount={pageCount}
                  onPage={setPage}
                  prevLabel={t('pagination.prev', { defaultValue: 'Previous' })}
                  nextLabel={t('pagination.next', { defaultValue: 'Next' })}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing
            ? t('stores.edit', { defaultValue: 'Edit store' })
            : t('stores.create', { defaultValue: 'Add store' })
        }
        description={t('stores.createHint', {
          defaultValue: 'Stores are matched to orders so tickets can be reported by branch.',
        })}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="store-form" loading={isSubmitting}>
              {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
            </Button>
          </>
        }
      >
        <form id="store-form" onSubmit={onSubmit} className="space-y-5" noValidate>
          <DrawerSection
            title={t('stores.sectionBranch', { defaultValue: 'Branch' })}
            description={t('stores.sectionBranchHint', {
              defaultValue: 'The code and name as they appear in your operations sheet.',
            })}
          >
            {/* First field, mirroring the leftmost table column: this is the join
                key to the order feed, so it should be the first thing you see and
                the first thing you can correct. */}
            <FormField
              label={t('stores.yijiRestaurantId', { defaultValue: 'Restaurant ID' })}
              hint={
                canEditYijiId
                  ? t('stores.yijiRestaurantIdHint', {
                      defaultValue:
                        'The id from the order system. When set, it takes priority over name matching for every by-store report.',
                    })
                  : t('stores.yijiRestaurantIdLocked', {
                      defaultValue:
                        'Only the Administrator can change this. It is the join key to the order feed: a wrong value does not error, it silently reports tickets against the wrong branch.',
                    })
              }
            >
              <Input {...register('yiji_restaurant_id')} disabled={!canEditYijiId} />
            </FormField>
            <FormField
              label={t('stores.name', { defaultValue: 'Store name' })}
              error={errors.name?.message}
              hint={t('stores.nameHint', { defaultValue: 'Branch only, e.g. Marina Mall 2.' })}
            >
              <Input invalid={!!errors.name} {...register('name')} />
            </FormField>
            <FormField
              label={t('stores.code', { defaultValue: 'Store code' })}
              hint={t('stores.codeHint', { defaultValue: 'e.g. LCP-002.' })}
            >
              <Input {...register('code')} />
            </FormField>
            <FormField label={t('stores.city', { defaultValue: 'City' })}>
              <Input {...register('city')} />
            </FormField>
            <FormField label={t('stores.brand', { defaultValue: 'Brand' })}>
              <Select {...register('brand')}>
                <option value="">{t('stores.noBrandOption', { defaultValue: '— none —' })}</option>
                {(brands.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </Select>
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('stores.sectionPeople', { defaultValue: 'Ownership' })}
            description={t('stores.sectionPeopleHint', {
              defaultValue: 'Shown as columns in the ticket report.',
            })}
          >
            <FormField label={t('stores.areaManager', { defaultValue: 'Area manager' })}>
              <Input {...register('area_manager')} />
            </FormField>
            <FormField label={t('stores.chainManager', { defaultValue: 'Chain manager' })}>
              <Input {...register('chain_manager')} />
            </FormField>
            <FormField label={t('stores.status', { defaultValue: 'Status' })}>
              <Select {...register('status')}>
                <option value="active">{t('stores.active', { defaultValue: 'Active' })}</option>
                <option value="inactive">
                  {t('stores.inactive', { defaultValue: 'Inactive' })}
                </option>
              </Select>
            </FormField>
          </DrawerSection>
        </form>
      </Drawer>

      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void onDelete()}
        destructive
        title={t('stores.deleteTitle', { defaultValue: 'Delete this store?' })}
        description={t('stores.deleteHint', {
          defaultValue:
            'Tickets keep their order data, but this branch will show as unmapped in reports and dashboards.',
        })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
      />
    </div>
  );
}
