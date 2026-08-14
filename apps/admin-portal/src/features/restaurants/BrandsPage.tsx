import { useState } from 'react';
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
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useBrands,
  useCreateBrand,
  useUpdateBrand,
  useDeleteBrand,
  useStores,
  type Brand,
} from './api.js';

const schema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  yiji_brand_name: z.string().optional(),
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

export function BrandsPage() {
  const { t } = useTranslation();
  const brands = useBrands();
  const stores = useStores();
  const createBrand = useCreateBrand();
  const updateBrand = useUpdateBrand();
  const deleteBrand = useDeleteBrand();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Brand | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', name: '', yiji_brand_name: '', status: 'active' },
  });

  const openCreate = () => {
    setEditing(null);
    reset({ code: '', name: '', yiji_brand_name: '', status: 'active' });
    setOpen(true);
  };

  const openEdit = (b: Brand) => {
    setEditing(b);
    reset({
      code: b.code,
      name: b.name,
      yiji_brand_name: b.yiji_brand_name ?? '',
      status: b.status,
    });
    setOpen(true);
  };

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      ...values,
      yiji_brand_name: values.yiji_brand_name?.trim() ? values.yiji_brand_name.trim() : null,
    };
    try {
      if (editing) {
        await updateBrand.mutateAsync({ id: editing.id, ...payload });
        toast.success(t('brands.updated', { defaultValue: 'Brand updated.' }));
      } else {
        await createBrand.mutateAsync(payload);
        toast.success(t('brands.created', { defaultValue: 'Brand created.' }));
      }
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('brands.saveError', { defaultValue: 'Could not save the brand.' }));
    }
  });

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteBrand.mutateAsync(confirmDelete.id);
      toast.success(t('brands.deleted', { defaultValue: 'Brand deleted.' }));
    } catch {
      toast.error(t('brands.deleteError', { defaultValue: 'Could not delete the brand.' }));
    } finally {
      setConfirmDelete(null);
    }
  };

  const list = brands.data ?? [];
  const storeList = stores.data ?? [];
  const storeCountFor = (id: string) => storeList.filter((s) => s.brand?.id === id).length;
  const activeCount = list.filter((b) => b.status === 'active').length;
  const brandedStores = storeList.filter((s) => s.brand).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('brands.title', { defaultValue: 'Brands' })}
        </h1>
        <ToolbarSpacer />
        <Button type="button" size="sm" onClick={openCreate} iconStart={<PlusIcon />}>
          {t('brands.create', { defaultValue: 'Add brand' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {!brands.isLoading && !brands.isError && list.length > 0 && (
          <div className="mx-auto mb-5 max-w-5xl space-y-5">
            <div className="border-b border-foreground/10 pb-5">
              <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                {t('brands.title', { defaultValue: 'Brands' })}
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('brands.heroSubtitle', {
                  defaultValue:
                    'The restaurant brands you operate. Each store belongs to a brand, and ticket reports break down by both.',
                })}
              </p>
            </div>
            <StatStrip
              items={[
                {
                  label: t('brands.total', { defaultValue: 'brands' }),
                  value: list.length,
                  tone: 'blue',
                },
                {
                  label: t('brands.active', { defaultValue: 'active' }),
                  value: activeCount,
                  tone: 'green',
                },
                {
                  label: t('brands.storesLinked', { defaultValue: 'stores linked' }),
                  value: brandedStores,
                  tone: 'violet',
                },
              ]}
            />
          </div>
        )}

        {brands.isError ? (
          <ErrorState
            title={t('brands.loadError', { defaultValue: 'Could not load brands' })}
            message={t('brands.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void brands.refetch()}
          />
        ) : brands.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
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
            title={t('brands.empty', { defaultValue: 'No brands yet' })}
            description={t('brands.emptyHint', {
              defaultValue:
                'Add your first brand, then add its stores. Ticket reports use these to show brand and city.',
            })}
            action={
              <Button type="button" onClick={openCreate} iconStart={<PlusIcon />}>
                {t('brands.create', { defaultValue: 'Add brand' })}
              </Button>
            }
          />
        ) : (
          /* Board list rows — hairline separators edge to edge, the accent
             hover wash, numbers right-aligned in the end column. */
          <ul className="mx-auto max-w-5xl overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft">
            {list.map((b) => (
              <li key={b.id} className="border-b border-border/60 last:border-b-0">
                <div
                  className={cn(
                    'group flex w-full items-center gap-3 px-4 py-3 text-start',
                    'transition-colors duration-fast ease-out hover:bg-primary/[0.05]',
                  )}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-subtle text-2xs font-bold uppercase text-primary">
                    {b.code.slice(0, 3)}
                  </span>
                  <button
                    type="button"
                    onClick={() => openEdit(b)}
                    className="min-w-0 flex-1 text-start focus-visible:outline-none"
                  >
                    <div className="truncate text-sm font-medium text-foreground">{b.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {b.code}
                      {b.yiji_brand_name && b.yiji_brand_name !== b.name && (
                        <>
                          {' · '}
                          {t('brands.yijiAs', { defaultValue: 'Yiji sends' })} “{b.yiji_brand_name}”
                        </>
                      )}
                    </div>
                  </button>
                  {b.status === 'inactive' && (
                    <Pill tone="muted">{t('brands.inactive', { defaultValue: 'Inactive' })}</Pill>
                  )}
                  <span className="w-24 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                    {/* Number leads in foreground weight; the unit stays quiet. */}
                    <span className="font-semibold text-foreground">
                      {storeCountFor(b.id)}
                    </span>{' '}
                    {t('brands.storesUnit', { defaultValue: 'stores' })}
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(b)}>
                    {t('actions.edit', { ns: 'common', defaultValue: 'Edit' })}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(b)}
                  >
                    {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing
            ? t('brands.edit', { defaultValue: 'Edit brand' })
            : t('brands.create', { defaultValue: 'Add brand' })
        }
        description={t('brands.createHint', {
          defaultValue: 'Brands group your stores and appear as a column in the ticket report.',
        })}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="brand-form" loading={isSubmitting}>
              {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
            </Button>
          </>
        }
      >
        <form id="brand-form" onSubmit={onSubmit} className="space-y-5" noValidate>
          <DrawerSection
            title={t('brands.sectionIdentity', { defaultValue: 'Brand identity' })}
            description={t('brands.sectionIdentityHint', {
              defaultValue: 'The short code is what your store sheet uses, e.g. LCP.',
            })}
          >
            <FormField
              label={t('brands.code', { defaultValue: 'Code' })}
              error={errors.code?.message}
              hint={t('brands.codeHint', { defaultValue: 'Short code, e.g. LCP or CND.' })}
            >
              <Input invalid={!!errors.code} {...register('code')} />
            </FormField>
            <FormField
              label={t('brands.name', { defaultValue: 'Brand name' })}
              error={errors.name?.message}
              hint={t('brands.nameHint', { defaultValue: 'Full name, e.g. La Casa Pasta.' })}
            >
              <Input invalid={!!errors.name} {...register('name')} />
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('brands.sectionMatching', { defaultValue: 'Order matching' })}
            description={t('brands.sectionMatchingHint', {
              defaultValue:
                'Only needed when the order system spells the brand differently from the name above.',
            })}
          >
            <FormField
              label={t('brands.yijiBrandName', { defaultValue: 'Name in the order system' })}
              hint={t('brands.yijiBrandNameHint', {
                defaultValue:
                  'Leave blank if it matches the brand name. Spacing and capitalisation are ignored when matching.',
              })}
            >
              <Input {...register('yiji_brand_name')} />
            </FormField>
            <FormField label={t('brands.status', { defaultValue: 'Status' })}>
              <Select {...register('status')}>
                <option value="active">{t('brands.active', { defaultValue: 'Active' })}</option>
                <option value="inactive">
                  {t('brands.inactive', { defaultValue: 'Inactive' })}
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
        title={t('brands.deleteTitle', { defaultValue: 'Delete this brand?' })}
        description={t('brands.deleteHint', {
          defaultValue:
            'Its stores are kept, but they lose their brand link and will show as unmapped in reports until you reassign them.',
        })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
      />
    </div>
  );
}
