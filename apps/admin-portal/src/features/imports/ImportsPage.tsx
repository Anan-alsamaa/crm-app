import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { uploadFiles } from '@directus/sdk';
import {
  Button,
  EmptyState,
  FormField,
  SelectMenu,
  Skeleton,
  StoreIcon,
  Table,
  TableSurface,
  Td,
  Th,
  toast,
  cn,
  Toolbar,
  ToolbarSpacer,
  Tr,
  UploadIcon,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { jobProducer } from '../../lib/job-producer.js';
import { useVendors } from '../vendors/api.js';

/**
 * Admin contact CSV import.
 *
 * Upload CSV → preview header row → map columns to contact fields → submit
 * job. The actual import runs in the workers service (imports queue) via a
 * Directus job hook; here we POST the file + manifest. Per-vendor dedup is
 * handled in the worker.
 */

const CONTACT_FIELDS = ['name', 'email', 'phone', 'external_customer_id'] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

interface PreviewData {
  fileId: string;
  filename: string;
  header: string[];
  sample: string[][];
}

export function ImportsPage() {
  const { t } = useTranslation();
  const vendors = useVendors();
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [vendorId, setVendorId] = useState('');

  // With a single vendor the picker is a decision the operator cannot get wrong,
  // so making them open it just to choose the only option is friction — and an
  // empty "—" reads as "nothing configured". Preselect it; the control stays
  // visible and editable for when there is more than one.
  const vendorList = vendors.data ?? [];
  useEffect(() => {
    if (!vendorId && vendorList.length === 1) setVendorId(vendorList[0]!.id);
  }, [vendorId, vendorList]);
  const [mapping, setMapping] = useState<Record<string, ContactField>>({});

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const result = (await directus.request(uploadFiles(form))) as
        | { id: string; filename_download: string }
        | Array<{ id: string; filename_download: string }>;
      const f = Array.isArray(result) ? result[0]! : result;
      // Parse first 5 lines to preview.
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 6);
      const header = lines[0]?.split(',').map((s) => s.trim().replace(/^"|"$/g, '')) ?? [];
      const sample = lines
        .slice(1)
        .map((l) => l.split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
      setPreview({ fileId: f.id, filename: f.filename_download, header, sample });
      // Auto-map header → field when header text matches a known field.
      const autoMap: Record<string, ContactField> = {};
      for (const h of header) {
        const lower = h.toLowerCase();
        const match = CONTACT_FIELDS.find((cf) => cf === lower || cf.replace(/_/g, '') === lower);
        if (match) autoMap[h] = match;
      }
      setMapping(autoMap);
      toast.success(
        t('imports.uploaded', { defaultValue: 'File uploaded — map columns and submit.' }),
      );
    },
    onError: () => toast.error(t('imports.uploadError', { defaultValue: 'Upload failed.' })),
  });

  const submitJob = useMutation({
    mutationFn: async () => {
      if (!preview || !vendorId) throw new Error('preview/vendor missing');
      // Enqueue an ImportJob on the workers `imports` queue via the host-run
      // job producer (tools/job-producer). The worker fetches the uploaded
      // CSV, applies this column mapping, and upserts contacts with per-vendor
      // dedup. Shape MUST match shared-types ImportJob { fileId, vendorId, mapping }.
      return jobProducer.enqueueImport({ fileId: preview.fileId, vendorId, mapping });
    },
    onSuccess: (info) => {
      toast.success(
        t('imports.queued', {
          defaultValue: `Import queued (job ${info.jobId}). The worker will process it shortly.`,
        }),
      );
      setPreview(null);
      setMapping({});
    },
    onError: (err) =>
      toast.error(
        t('imports.queueError', {
          message: (err as Error).message,
          defaultValue: 'Could not queue import: {{message}}',
        }),
      ),
  });

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) upload.mutate(f);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('imports.title', { defaultValue: 'Import contacts' })}
        </h1>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          disabled={!preview || !vendorId}
          loading={submitJob.isPending}
          onClick={() => submitJob.mutate()}
        >
          {t('imports.queue', { defaultValue: 'Queue import' })}
        </Button>
      </Toolbar>

      <div className="mx-auto w-full max-w-4xl flex-1 overflow-auto px-6 py-8 space-y-6 sm:px-10">
        {/* Clean editorial header — no gradient banner. */}
        <div className="border-b border-foreground/10 pb-5">
          <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            {t('imports.title', { defaultValue: 'Import contacts' })}
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t('imports.heroSubtitle', {
              defaultValue:
                'Upload a CSV, map its columns to contact fields, preview the first rows, then queue the import. Deduplication runs per-vendor on phone or email.',
            })}
          </p>
        </div>

        {/* Vendor select — an action card with a tinted icon chip. */}
        <section className="rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft px-5 py-5">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-tint text-sky"
            >
              <StoreIcon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <FormField
                label={t('imports.vendor', { defaultValue: 'Target vendor' })}
                hint={t('imports.vendorHint', {
                  defaultValue: 'Dedup runs per-vendor on phone OR email.',
                })}
              >
                <SelectMenu
                  fullWidth
                  value={vendorId}
                  onChange={(v) => setVendorId(v)}
                  aria-label={t('imports.vendor', { defaultValue: 'Target vendor' })}
                  placeholder="—"
                  options={[
                    { value: '', label: '—' },
                    ...(vendors.data ?? []).map((v) => ({
                      value: v.id,
                      label: `${v.name} (${v.yiji_vendor_id})`,
                    })),
                  ]}
                />
              </FormField>
            </div>
          </div>
        </section>

        {/* File upload — same card anatomy, upload chip in the jade tint. */}
        <section className="rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft px-5 py-5">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary"
            >
              <UploadIcon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <FormField label={t('imports.file', { defaultValue: 'CSV file' })}>
                {/* A bare <input type="file"> renders the BROWSER's control — grey
                    "Choose File | No file chosen" — which ignores the design system
                    entirely and is the one obviously foreign element on the page.
                    The input stays (it is what actually opens the picker and what
                    assistive tech drives) but is visually hidden inside a styled
                    label, so the whole area is a proper drop target. */}
                <label
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-secondary/40 px-4 py-7 text-center transition-colors duration-fast',
                    'hover:border-primary/50 hover:bg-primary/[0.04] focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/40',
                  )}
                >
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={onFileChange}
                    className="sr-only"
                  />
                  <span className="text-sm font-medium text-foreground">
                    {preview
                      ? t('imports.chooseAnother', { defaultValue: 'Choose a different CSV' })
                      : t('imports.chooseFile', { defaultValue: 'Choose a CSV file' })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('imports.fileHint', {
                      defaultValue: 'Header row required. UTF-8 recommended.',
                    })}
                  </span>
                </label>
              </FormField>
              {upload.isPending && <Skeleton className="h-4 w-32 mt-2" />}
              {preview && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('imports.uploaded', { defaultValue: 'File uploaded' })}:{' '}
                  <span className="font-mono">{preview.filename}</span>
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Mapping + preview */}
        {preview && (
          <section className="space-y-3">
            <h2 className="px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('imports.mapping', { defaultValue: 'Column mapping' })}
            </h2>
            <div className="rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft px-5 py-5 space-y-3">
              {preview.header.map((h) => (
                <div key={h} className="grid grid-cols-12 items-center gap-2">
                  {/* The CSV's own header, as a code chip. */}
                  <span className="col-span-5 max-w-full justify-self-start truncate rounded-md bg-secondary px-2 py-1 font-mono text-2xs text-foreground ring-1 ring-inset ring-foreground/[0.06]">
                    {h}
                  </span>
                  <span className="col-span-1 text-center text-muted-foreground">→</span>
                  <div className="col-span-6">
                    <SelectMenu
                      fullWidth
                      value={mapping[h] ?? ''}
                      onChange={(val) => {
                        const v = val as ContactField | '';
                        const next = { ...mapping };
                        if (v) next[h] = v;
                        else delete next[h];
                        setMapping(next);
                      }}
                      aria-label={`${t('imports.mapping', { defaultValue: 'Column mapping' })}: ${h}`}
                      options={[
                        { value: '', label: '— skip —' },
                        ...CONTACT_FIELDS.map((cf) => ({ value: cf, label: cf })),
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>

            <h2 className="px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('imports.preview', { defaultValue: 'Preview (first 5 rows)' })}
            </h2>
            <TableSurface>
              <Table>
                <thead>
                  <tr>
                    {preview.header.map((h) => (
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, i) => (
                    <Tr key={i}>
                      {row.map((cell, j) => (
                        <Td key={j} className="text-foreground/80 tabular-nums">
                          {cell}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableSurface>
          </section>
        )}

        {!preview && !upload.isPending && (
          /* Composed empty state — icon chip + title, never bare text lines
             floating in the dead space under the cards. */
          <EmptyState
            icon={<UploadIcon size={20} />}
            title={t('imports.empty', { defaultValue: 'Upload a CSV to begin' })}
            description={t('imports.emptyHint', {
              defaultValue:
                'Map columns to contact fields, preview the first rows, then queue the import.',
            })}
          />
        )}
      </div>
    </div>
  );
}
