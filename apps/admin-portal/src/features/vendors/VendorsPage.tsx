import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { uploadFiles } from '@directus/sdk';
import {
  Button,
  cn,
  Drawer,
  DrawerSection,
  EmptyState,
  FormField,
  Input,
  Skeleton,
  Spinner,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { useVendors, useCreateVendor, useUpdateVendor, type VendorRow } from './api.js';

const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

/**
 * Vendor management.
 *
 * List view shows every vendor as a soft card with a live preview of its
 * brand colors. Selecting a vendor (or "+ New") opens a drawer with the
 * branding editor: name, yiji_vendor_id, primary + secondary colors with
 * hex inputs + color swatches, status toggle.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const schema = z.object({
  name: z.string().min(1),
  yiji_vendor_id: z.string().min(1),
  primary: z.string().regex(HEX, 'Use #RRGGBB').optional().or(z.literal('')),
  secondary: z.string().regex(HEX, 'Use #RRGGBB').optional().or(z.literal('')),
  status: z.enum(['active', 'inactive']),
});
type FormValues = z.infer<typeof schema>;

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

export function VendorsPage() {
  const { t } = useTranslation();
  const vendors = useVendors();
  const create = useCreateVendor();
  const update = useUpdateVendor();
  const [editing, setEditing] = useState<VendorRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [logoId, setLogoId] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'active' },
  });

  useEffect(() => {
    if (drawerOpen && editing) {
      setLogoId(editing.logo ?? null);
      form.reset({
        name: editing.name,
        yiji_vendor_id: editing.yiji_vendor_id,
        primary: editing.colors?.primary ?? '',
        secondary: editing.colors?.secondary ?? '',
        status: editing.status,
      });
    } else if (drawerOpen && !editing) {
      setLogoId(null);
      form.reset({
        name: '',
        yiji_vendor_id: '',
        primary: '#0F8D8F',
        secondary: '#EC4899',
        status: 'active',
      });
    }
  }, [drawerOpen, editing, form]);

  const onPickLogo = async (file: File | null): Promise<void> => {
    if (!file) return;
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = (await directus.request(uploadFiles(fd))) as { id: string };
      setLogoId(res.id);
    } catch {
      toast.error(t('vendors.logoError', { defaultValue: 'Could not upload the logo.' }));
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const colors: { primary?: string; secondary?: string } = {};
    if (values.primary) colors.primary = values.primary;
    if (values.secondary) colors.secondary = values.secondary;
    try {
      if (editing) {
        await update.mutateAsync({
          id: editing.id,
          patch: {
            name: values.name,
            yiji_vendor_id: values.yiji_vendor_id,
            colors,
            logo: logoId,
            status: values.status,
          },
        });
        toast.success(t('vendors.updated', { defaultValue: 'Vendor updated.' }));
      } else {
        await create.mutateAsync({
          name: values.name,
          yiji_vendor_id: values.yiji_vendor_id,
          colors,
          logo: logoId,
          status: values.status,
        });
        toast.success(t('vendors.created', { defaultValue: 'Vendor created.' }));
      }
      setDrawerOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('vendors.saveError', { defaultValue: 'Could not save vendor.' }));
    }
  });

  const total = vendors.data?.length ?? 0;
  const activeCount = (vendors.data ?? []).filter((v) => v.status === 'active').length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('vendors.title', { defaultValue: 'Vendors' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong>{' '}
            {t('vendors.total', { defaultValue: 'vendors' })}
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{activeCount}</strong>{' '}
            {t('vendors.active', { defaultValue: 'active' })}
          </span>
        </span>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditing(null);
            setDrawerOpen(true);
          }}
          iconStart={<PlusIcon />}
        >
          {t('vendors.create', { defaultValue: 'New vendor' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {vendors.isLoading ? (
          <div className="mx-auto max-w-5xl divide-y divide-border overflow-hidden rounded-2xl ring-1 ring-border shadow-soft bg-card/60">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-1/4" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : !vendors.data || vendors.data.length === 0 ? (
          <EmptyState
            title={t('vendors.empty', { defaultValue: 'No vendors yet.' })}
            description={t('vendors.emptyHint', {
              defaultValue: 'Create your first vendor to start receiving conversations.',
            })}
            action={
              <Button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setDrawerOpen(true);
                }}
                iconStart={<PlusIcon />}
              >
                {t('vendors.create', { defaultValue: 'New vendor' })}
              </Button>
            }
          />
        ) : (
          <ul className="mx-auto max-w-5xl divide-y divide-border overflow-hidden rounded-2xl bg-card/60 ring-1 ring-border shadow-soft">
            {vendors.data.map((v) => (
              <li key={v.id}>
                <VendorCard
                  v={v}
                  onEdit={() => {
                    setEditing(v);
                    setDrawerOpen(true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
        title={
          editing
            ? t('vendors.edit', { defaultValue: 'Edit vendor' })
            : t('vendors.create', { defaultValue: 'New vendor' })
        }
        description={t('vendors.drawerHint', {
          defaultValue:
            'Branding here drives the customer chat widget for every conversation routed to this vendor.',
        })}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDrawerOpen(false);
                setEditing(null);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="vendor-form" loading={form.formState.isSubmitting}>
              {t('actions.save', { ns: 'common' })}
            </Button>
          </>
        }
      >
        <form id="vendor-form" onSubmit={onSubmit} className="space-y-6" noValidate>
          <DrawerSection
            title={t('vendors.sectionIdentity', { defaultValue: 'Identity' })}
            description={t('vendors.sectionIdentityHint', {
              defaultValue: 'How the vendor appears in the admin console and routing rules.',
            })}
          >
            <FormField
              label={t('vendors.name', { defaultValue: 'Name' })}
              error={form.formState.errors.name?.message}
            >
              <Input invalid={!!form.formState.errors.name} {...form.register('name')} />
            </FormField>
            <FormField
              label={t('vendors.yijiId', { defaultValue: 'Yiji vendor ID' })}
              hint={t('vendors.yijiIdHint', {
                defaultValue:
                  'The vendor identifier from the upstream Yiji platform — used for commerce lookups.',
              })}
              error={form.formState.errors.yiji_vendor_id?.message}
            >
              <Input
                invalid={!!form.formState.errors.yiji_vendor_id}
                {...form.register('yiji_vendor_id')}
                placeholder="demo-vendor"
              />
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('vendors.sectionBranding', { defaultValue: 'Branding' })}
            description={t('vendors.sectionBrandingHint', {
              defaultValue: 'Logo + colors propagate to the chat widget. Use #RRGGBB hex.',
            })}
          >
            <FormField label={t('vendors.logo', { defaultValue: 'Logo' })}>
              <div className="flex items-center gap-3">
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-secondary ring-1 ring-border">
                  {logoId ? (
                    <img
                      src={`${DIRECTUS_URL}/assets/${logoId}?width=96&height=96&fit=cover`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-base font-semibold text-muted-foreground">
                      {(form.watch('name') ?? '?').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => void onPickLogo(e.target.files?.[0] ?? null)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploadingLogo}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {uploadingLogo ? (
                    <Spinner size={14} />
                  ) : logoId ? (
                    t('vendors.replaceLogo', { defaultValue: 'Replace' })
                  ) : (
                    t('vendors.uploadLogo', { defaultValue: 'Upload logo' })
                  )}
                </Button>
                {logoId && (
                  <button
                    type="button"
                    onClick={() => setLogoId(null)}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('actions.remove', { ns: 'common', defaultValue: 'Remove' })}
                  </button>
                )}
              </div>
            </FormField>
            <ColorField
              label={t('vendors.primary', { defaultValue: 'Primary color' })}
              register={form.register('primary')}
              error={form.formState.errors.primary?.message}
              value={form.watch('primary') ?? ''}
            />
            <ColorField
              label={t('vendors.secondary', { defaultValue: 'Secondary color' })}
              register={form.register('secondary')}
              error={form.formState.errors.secondary?.message}
              value={form.watch('secondary') ?? ''}
            />
            <BrandPreview primary={form.watch('primary')} secondary={form.watch('secondary')} />
          </DrawerSection>

          <DrawerSection
            title={t('vendors.sectionStatus', { defaultValue: 'Status' })}
            description={t('vendors.sectionStatusHint', {
              defaultValue: 'Inactive vendors hide from routing but keep their data.',
            })}
          >
            <FormField label={t('vendors.status', { defaultValue: 'Status' })}>
              <div className="flex gap-1">
                {(['active', 'inactive'] as const).map((s) => {
                  const checked = form.watch('status') === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => form.setValue('status', s, { shouldDirty: true })}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 h-8 text-xs font-medium transition-colors duration-fast ease-out',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                        checked
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary/60 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`vendors.${s}`, { defaultValue: s })}
                    </button>
                  );
                })}
              </div>
            </FormField>
          </DrawerSection>
        </form>
      </Drawer>
    </div>
  );
}

function VendorCard({ v, onEdit }: { v: VendorRow; onEdit: () => void }) {
  const { t } = useTranslation();
  const primary = v.colors?.primary ?? '#94a3b8';
  const secondary = v.colors?.secondary ?? '#cbd5e1';
  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        'group flex w-full items-center gap-3 px-4 py-2.5 text-start',
        'transition-colors duration-fast ease-out hover:bg-secondary/50',
        'focus-visible:outline-none focus-visible:bg-secondary/60',
      )}
    >
      {/* Two-tone brand chip — the vendor's primary + secondary at a glance. */}
      <span
        aria-hidden
        title={`${primary} · ${secondary}`}
        className="flex h-8 w-8 shrink-0 overflow-hidden rounded-lg ring-1 ring-foreground/10"
      >
        <span className="h-full w-1/2" style={{ background: primary }} />
        <span className="h-full w-1/2" style={{ background: secondary }} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{v.name}</span>
          {v.status === 'inactive' && (
            <span className="inline-flex items-center rounded-full bg-warning/20 px-2 py-0.5 text-2xs font-medium text-warning-foreground">
              {t('vendors.inactive', { defaultValue: 'inactive' })}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-2xs text-muted-foreground">{v.yiji_vendor_id}</div>
      </div>
      <span className="hidden shrink-0 font-mono text-2xs text-muted-foreground sm:block">
        {primary}
      </span>
    </button>
  );
}

function ColorField({
  label,
  register,
  error,
  value,
}: {
  label: string;
  register: ReturnType<ReturnType<typeof useForm<FormValues>>['register']>;
  error?: string;
  value: string;
}) {
  const swatch = HEX.test(value) ? value : '#e5e7eb';
  return (
    <FormField label={label} error={error}>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-10 w-10 shrink-0 rounded-xl ring-1 ring-foreground/10"
          style={{ background: swatch }}
        />
        <Input
          placeholder="#0F8D8F"
          className="font-mono tabular-nums"
          invalid={!!error}
          {...register}
        />
      </div>
    </FormField>
  );
}

function BrandPreview({ primary, secondary }: { primary?: string; secondary?: string }) {
  const { t } = useTranslation();
  const p = primary && HEX.test(primary) ? primary : '#0F8D8F';
  const s = secondary && HEX.test(secondary) ? secondary : '#EC4899';
  return (
    <div className="space-y-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('vendors.preview', { defaultValue: 'Preview' })}
      </div>
      <div
        className="relative overflow-hidden rounded-2xl p-6 text-white shadow-sm shadow-foreground/[0.06]"
        style={{
          background: `radial-gradient(at 0% 0%, ${s}aa 0%, transparent 55%), radial-gradient(at 100% 100%, ${p} 0%, ${p} 60%, transparent 100%), ${p}`,
        }}
      >
        <div className="text-sm font-semibold tracking-tight">
          {t('vendors.previewGreeting', { defaultValue: 'Hi there' })}
        </div>
        <div className="mt-1 text-xs opacity-80">
          {t('vendors.previewSub', { defaultValue: "We're here to help." })}
        </div>
      </div>
    </div>
  );
}
