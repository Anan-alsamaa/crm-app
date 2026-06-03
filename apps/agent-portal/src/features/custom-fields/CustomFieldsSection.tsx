import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { Button, FormField, Input, Select, Skeleton, toast } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Dynamic custom-field rendering.
 *
 * Reads the admin-defined fields for an entity type, then loads the
 * existing values (one custom_field_values row per (custom_field, entity))
 * and renders inputs matching each field's declared type. On Save writes
 * back via update-or-create.
 */

interface FieldDef {
  id: string;
  name: string;
  key: string;
  field_type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect';
  options: string[] | null;
  required: boolean;
  display_order: number;
}

interface FieldValue {
  id: string;
  custom_field: string;
  entity_type: string;
  entity_id: string;
  value: unknown;
}

interface Props {
  entityType: 'contact' | 'conversation' | 'ticket';
  entityId: string;
}

export function CustomFieldsSection({ entityType, entityId }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const defs = useQuery({
    queryKey: ['custom-fields', entityType],
    queryFn: () =>
      directus.request(
        readItems('custom_fields', {
          filter: { entity_type: { _eq: entityType } },
          fields: ['id', 'name', 'key', 'field_type', 'options', 'required', 'display_order'],
          sort: ['display_order', 'name'],
          limit: -1,
        }),
      ) as Promise<FieldDef[]>,
  });

  const values = useQuery({
    queryKey: ['custom-field-values', entityType, entityId],
    enabled: !!entityId,
    queryFn: () =>
      directus.request(
        readItems('custom_field_values', {
          filter: { entity_type: { _eq: entityType }, entity_id: { _eq: entityId } },
          fields: ['id', 'custom_field', 'entity_type', 'entity_id', 'value'],
          limit: -1,
        }),
      ) as Promise<FieldValue[]>,
  });

  const [draft, setDraft] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!defs.data || !values.data) return;
    const next: Record<string, unknown> = {};
    for (const d of defs.data) {
      const v = values.data.find((x) => x.custom_field === d.id);
      next[d.id] = v?.value ?? '';
    }
    setDraft(next);
  }, [defs.data, values.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!defs.data || !values.data) return;
      for (const d of defs.data) {
        const next = draft[d.id];
        const existing = values.data.find((x) => x.custom_field === d.id);
        if (existing) {
          await directus.request(
            updateItem('custom_field_values', existing.id, { value: next } as never),
          );
        } else if (next !== undefined && next !== '') {
          await directus.request(
            createItem('custom_field_values', {
              custom_field: d.id,
              entity_type: entityType,
              entity_id: entityId,
              value: next,
            } as never),
          );
        }
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-field-values', entityType, entityId] });
      toast.success(t('customFields.saved', { defaultValue: 'Custom fields saved.' }));
    },
    onError: () => toast.error(t('customFields.saveError', { defaultValue: 'Could not save.' })),
  });

  if (defs.isLoading)
    return (
      <div className="rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-5 py-4 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  if (!defs.data || defs.data.length === 0) return null;

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('customFields.title', { defaultValue: 'Custom fields' })}
        </h3>
        <Button type="button" size="sm" variant="outline" loading={save.isPending} onClick={() => save.mutate()}>
          {t('actions.save', { ns: 'common' })}
        </Button>
      </div>
      <div className="space-y-3">
        {defs.data.map((d) => (
          <FieldInput
            key={d.id}
            def={d}
            value={draft[d.id]}
            onChange={(v) => setDraft({ ...draft, [d.id]: v })}
          />
        ))}
      </div>
    </div>
  );
}

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const label = `${def.name}${def.required ? ' *' : ''}`;
  switch (def.field_type) {
    case 'text':
      return (
        <FormField label={label}>
          <Input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </FormField>
      );
    case 'number':
      return (
        <FormField label={label}>
          <Input
            type="number"
            value={(value as number | string) ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </FormField>
      );
    case 'date':
      return (
        <FormField label={label}>
          <Input
            type="date"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </FormField>
      );
    case 'boolean':
      return (
        <FormField label={label}>
          <Select
            value={value === true ? 'yes' : value === false ? 'no' : ''}
            onChange={(e) =>
              onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)
            }
          >
            <option value="">—</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </Select>
        </FormField>
      );
    case 'select':
      return (
        <FormField label={label}>
          <Select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(def.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case 'multiselect': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <FormField label={label}>
          <div className="flex flex-wrap gap-1.5">
            {(def.options ?? []).map((opt) => {
              const checked = current.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() =>
                    onChange(checked ? current.filter((x) => x !== opt) : [...current, opt])
                  }
                  className={`inline-flex items-center rounded-full px-3 h-7 text-xs transition-colors duration-fast ease-out ${
                    checked
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary/60 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </FormField>
      );
    }
  }
}
