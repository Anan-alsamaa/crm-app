import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  Drawer,
  DrawerSection,
  EmptyState,
  FormField,
  Input,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { useVendors, useCreateVendor, useUpdateVendor, type VendorRow } from './api.js';

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
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden>
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

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'active' },
  });

  useEffect(() => {
    if (drawerOpen && editing) {
      form.reset({
        name: editing.name,
        yiji_vendor_id: editing.yiji_vendor_id,
        primary: editing.colors?.primary ?? '',
        secondary: editing.colors?.secondary ?? '',
        status: editing.status,
      });
    } else if (drawerOpen && !editing) {
      form.reset({
        name: '',
        yiji_vendor_id: '',
        primary: '#0F8D8F',
        secondary: '#EC4899',
        status: 'active',
      });
    }
  }, [drawerOpen, editing, form]);

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
            status: values.status,
          },
        });
        toast.success(t('vendors.updated', { defaultValue: 'Vendor updated.' }));
      } else {
        await create.mutateAsync({
          name: values.name,
          yiji_vendor_id: values.yiji_vendor_id,
          colors,
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
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-2xl" />
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
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
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
          defaultValue: 'Branding here drives the customer chat widget for every conversation routed to this vendor.',
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
            <FormField label={t('vendors.name', { defaultValue: 'Name' })} error={form.formState.errors.name?.message}>
              <Input invalid={!!form.formState.errors.name} {...form.register('name')} />
            </FormField>
            <FormField
              label={t('vendors.yijiId', { defaultValue: 'Yiji vendor ID' })}
              hint={t('vendors.yijiIdHint', {
                defaultValue: 'The vendor identifier from the upstream Yiji platform — used for commerce lookups.',
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
              defaultValue: 'Colors propagate to the chat widget. Use #RRGGBB hex.',
            })}
          >
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
        'group flex w-full flex-col gap-3 rounded-2xl bg-card/70 px-5 py-4 text-start',
        'shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04]',
        'transition-[box-shadow,transform,background-color] duration-fast ease-out',
        'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08] hover:-translate-y-px',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-foreground truncate">
              {v.name}
            </span>
            {v.status === 'inactive' && (
              <span className="inline-flex items-center rounded-full bg-warning/20 px-2 py-0.5 text-2xs font-medium text-warning-foreground">
                {t('vendors.inactive', { defaultValue: 'inactive' })}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-2xs font-mono text-muted-foreground">
            {v.yiji_vendor_id}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-foreground/10"
          style={{ background: primary }}
          title={`primary ${primary}`}
        />
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-foreground/10"
          style={{ background: secondary }}
          title={`secondary ${secondary}`}
        />
        <div className="ms-auto text-2xs text-muted-foreground tabular-nums">
          <span className="font-mono">{primary}</span>
        </div>
      </div>
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
        <Input placeholder="#0F8D8F" className="font-mono tabular-nums" invalid={!!error} {...register} />
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
        <div className="text-sm font-semibold tracking-tight">Hi there</div>
        <div className="mt-1 text-xs opacity-80">We&apos;re here to help.</div>
      </div>
    </div>
  );
}
