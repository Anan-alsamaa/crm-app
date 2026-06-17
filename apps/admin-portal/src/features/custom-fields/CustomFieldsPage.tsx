import { useEffect, useMemo, useState } from 'react';
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
  SelectMenu,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useCustomFields,
  useCreateField,
  useUpdateField,
  useDeleteField,
  type CustomField,
  type CustomFieldInput,
  type EntityType,
  type FieldType,
} from './api.js';

const ENTITY_TYPES: EntityType[] = ['contact', 'conversation', 'ticket'];
const FIELD_TYPES: FieldType[] = ['text', 'number', 'boolean', 'date', 'select', 'multiselect'];

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

interface Draft {
  entity_type: EntityType;
  name: string;
  key: string;
  field_type: FieldType;
  options: string;
  required: boolean;
  display_order: number;
}

const blank = (): Draft => ({
  entity_type: 'contact',
  name: '',
  key: '',
  field_type: 'text',
  options: '',
  required: false,
  display_order: 0,
});

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function CustomFieldsPage() {
  const { t } = useTranslation();
  const fields = useCustomFields();
  const create = useCreateField();
  const update = useUpdateField();
  const remove = useDeleteField();
  const [tab, setTab] = useState<EntityType>('contact');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const onDelete = async (): Promise<void> => {
    if (!deletingId) return;
    try {
      await remove.mutateAsync(deletingId);
      setDeletingId(null);
    } catch {
      toast.error(t('customFields.deleteError', { defaultValue: 'Could not delete field.' }));
    }
  };

  const byEntity = useMemo(() => {
    const all = fields.data ?? [];
    return ENTITY_TYPES.reduce<Record<EntityType, CustomField[]>>(
      (acc, et) => {
        acc[et] = all.filter((f) => f.entity_type === et);
        return acc;
      },
      { contact: [], conversation: [], ticket: [] },
    );
  }, [fields.data]);

  useEffect(() => {
    if (!drawerOpen) return;
    if (editingId) {
      const existing = fields.data?.find((f) => f.id === editingId);
      if (existing) {
        setDraft({
          entity_type: existing.entity_type,
          name: existing.name,
          key: existing.key,
          field_type: existing.field_type,
          options: (existing.options ?? []).join(', '),
          required: existing.required,
          display_order: existing.display_order,
        });
      }
    } else {
      setDraft({ ...blank(), entity_type: tab });
    }
  }, [drawerOpen, editingId, fields.data, tab]);

  const onSubmit = async (): Promise<void> => {
    if (!draft.name.trim()) {
      toast.error(t('customFields.nameRequired', { defaultValue: 'Name is required.' }));
      return;
    }
    const payload: CustomFieldInput = {
      entity_type: draft.entity_type,
      name: draft.name.trim(),
      key: (draft.key || slugify(draft.name)).trim(),
      field_type: draft.field_type,
      options:
        draft.field_type === 'select' || draft.field_type === 'multiselect'
          ? draft.options
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
      required: draft.required,
      display_order: draft.display_order,
    };
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, patch: payload });
        toast.success(t('customFields.updated', { defaultValue: 'Field updated.' }));
      } else {
        await create.mutateAsync(payload);
        toast.success(t('customFields.created', { defaultValue: 'Field created.' }));
      }
      setDrawerOpen(false);
      setEditingId(null);
    } catch {
      toast.error(t('customFields.saveError', { defaultValue: 'Could not save field.' }));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('customFields.title', { defaultValue: 'Custom fields' })}
        </h1>
        <span className="opacity-30 text-xs text-muted-foreground">·</span>
        <div className="flex items-center gap-x-4 text-xs">
          {ENTITY_TYPES.map((et) => {
            const active = tab === et;
            const count = byEntity[et].length;
            return (
              <button
                key={et}
                type="button"
                onClick={() => setTab(et)}
                className={cn(
                  'group relative inline-flex items-center gap-1.5 h-12 transition-colors duration-fast ease-out focus-visible:outline-none',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="font-medium capitalize">{et}</span>
                <span className="tabular-nums text-2xs text-muted-foreground/80">{count}</span>
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditingId(null);
            setDrawerOpen(true);
          }}
          iconStart={<PlusIcon />}
        >
          {t('customFields.create', { defaultValue: 'New field' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {fields.isError ? (
          <ErrorState
            title={t('customFields.loadError', { defaultValue: 'Could not load custom fields' })}
            message={t('customFields.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void fields.refetch()}
          />
        ) : fields.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : byEntity[tab].length === 0 ? (
          <EmptyState
            title={t('customFields.empty', {
              defaultValue: 'No custom fields for this entity yet.',
            })}
            description={t('customFields.emptyHint', {
              defaultValue:
                'Define fields once; they render dynamically in the agent portal on the matching entity.',
            })}
            action={
              <Button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDrawerOpen(true);
                }}
                iconStart={<PlusIcon />}
              >
                {t('customFields.create', { defaultValue: 'New field' })}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {byEntity[tab].map((f) => (
              <li key={f.id}>
                <FieldRow
                  f={f}
                  onEdit={() => {
                    setEditingId(f.id);
                    setDrawerOpen(true);
                  }}
                  onDelete={() => setDeletingId(f.id)}
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
          setEditingId(null);
        }}
        title={
          editingId
            ? t('customFields.edit', { defaultValue: 'Edit field' })
            : t('customFields.create', { defaultValue: 'New field' })
        }
        description={t('customFields.drawerHint', {
          defaultValue: 'Key is used as the storage identifier; auto-derived from name if blank.',
        })}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDrawerOpen(false);
                setEditingId(null);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="button" onClick={onSubmit} loading={create.isPending || update.isPending}>
              {t('actions.save', { ns: 'common' })}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <DrawerSection
            title={t('customFields.sectionTarget', { defaultValue: 'Target' })}
            description={t('customFields.sectionTargetHint', {
              defaultValue: 'Which entity type this field attaches to in the agent UI.',
            })}
          >
            <FormField label={t('customFields.entity', { defaultValue: 'Entity' })}>
              <SelectMenu
                fullWidth
                value={draft.entity_type}
                onChange={(v) => setDraft({ ...draft, entity_type: v as EntityType })}
                aria-label={t('customFields.entity', { defaultValue: 'Entity' })}
                options={ENTITY_TYPES.map((et) => ({ value: et, label: et }))}
              />
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('customFields.sectionDefinition', { defaultValue: 'Definition' })}
            description={t('customFields.sectionDefinitionHint', {
              defaultValue: 'Name is shown in the UI; key is the storage identifier.',
            })}
          >
            <FormField label={t('customFields.name', { defaultValue: 'Name' })}>
              <Input
                value={draft.name}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    name: e.target.value,
                    key: draft.key || slugify(e.target.value),
                  })
                }
              />
            </FormField>
            <FormField label={t('customFields.key', { defaultValue: 'Key' })}>
              <Input
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: slugify(e.target.value) })}
                className="font-mono text-xs"
              />
            </FormField>
            <FormField label={t('customFields.type', { defaultValue: 'Type' })}>
              <SelectMenu
                fullWidth
                value={draft.field_type}
                onChange={(v) => setDraft({ ...draft, field_type: v as FieldType })}
                aria-label={t('customFields.type', { defaultValue: 'Type' })}
                options={FIELD_TYPES.map((ft) => ({ value: ft, label: ft }))}
              />
            </FormField>
            {(draft.field_type === 'select' || draft.field_type === 'multiselect') && (
              <FormField
                label={t('customFields.options', { defaultValue: 'Options' })}
                hint={t('customFields.optionsHint', { defaultValue: 'Comma-separated list.' })}
              >
                <Input
                  value={draft.options}
                  onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                  placeholder="urgent, soon, later"
                />
              </FormField>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('customFields.required', { defaultValue: 'Required' })}>
                <SelectMenu
                  fullWidth
                  value={draft.required ? 'yes' : 'no'}
                  onChange={(v) => setDraft({ ...draft, required: v === 'yes' })}
                  aria-label={t('customFields.required', { defaultValue: 'Required' })}
                  options={[
                    { value: 'no', label: 'no' },
                    { value: 'yes', label: 'yes' },
                  ]}
                />
              </FormField>
              <FormField label={t('customFields.order', { defaultValue: 'Display order' })}>
                <Input
                  type="number"
                  value={draft.display_order}
                  onChange={(e) =>
                    setDraft({ ...draft, display_order: Number.parseInt(e.target.value, 10) || 0 })
                  }
                />
              </FormField>
            </div>
          </DrawerSection>
        </div>
      </Drawer>

      <ConfirmDialog
        open={deletingId !== null}
        destructive
        title={t('customFields.confirmDelete', { defaultValue: 'Delete this field?' })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
        loading={remove.isPending}
        onConfirm={() => void onDelete()}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}

function FieldRow({
  f,
  onEdit,
  onDelete,
}: {
  f: CustomField;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'group flex items-start justify-between gap-4 rounded-2xl bg-card/70 px-5 py-4',
        'shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04]',
        'transition-[box-shadow,transform,background-color] duration-fast ease-out',
        'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08]',
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{f.name}</h3>
          <span className="font-mono text-2xs text-muted-foreground">{f.key}</span>
          {f.required && (
            <Pill tone="warning" size="sm">
              {t('customFields.requiredShort', { defaultValue: 'required' })}
            </Pill>
          )}
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <Pill tone="primary" size="sm">
            {f.field_type}
          </Pill>
          <span className="tabular-nums">#{f.display_order}</span>
          {(f.options?.length ?? 0) > 0 && (
            <span className="truncate">opts: {f.options!.join(', ')}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="text-xs font-semibold text-[oklch(0.42_0.10_196)] underline-offset-2 hover:underline"
        >
          {t('actions.edit', { ns: 'common', defaultValue: 'edit' })}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-2xs font-medium text-destructive underline-offset-2 hover:underline"
        >
          {t('actions.delete', { ns: 'common', defaultValue: 'delete' })}
        </button>
      </div>
    </div>
  );
}
