import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Pill,
  SelectMenu,
  Skeleton,
  Toolbar,
  ToolbarSpacer,
  cn,
  toast,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * The dropdown lists, editable by the operations team.
 *
 * Adding a complaint type used to be a code change and a deploy; now it is a
 * row in `option_lists` and the forms pick it up on their next fetch. Two rules
 * shape everything here:
 *
 *   1. RETIRE, don't delete. A value that has ever been saved onto a ticket is
 *      part of history; deleting it from the list must not rewrite what old
 *      tickets say. Deactivating stops it being OFFERED while every stored
 *      occurrence keeps displaying. Hard delete is offered only as the small
 *      secondary action, for typos caught immediately.
 *   2. The stored spellings are the operations team's own — "Comp. Twiter",
 *      "Dinning" — and this page must never "fix" them. Reports group by the
 *      exact string; a corrected spelling is a NEW value that splits history.
 */
const LIST_KEYS = [
  'complaint_type',
  'service_type',
  'complaint_source',
  'communication_method',
  'compensation',
] as const;
type ListKey = (typeof LIST_KEYS)[number];

interface OptionRow {
  id: string;
  list: string;
  value: string;
  sort: number | null;
  active: boolean;
}

function useOptionRows() {
  return useQuery({
    queryKey: ['option-lists-admin'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'option_lists' as never,
          {
            limit: -1,
            sort: ['list', 'sort', 'value'],
            fields: ['id', 'list', 'value', 'sort', 'active'],
          } as never,
        ),
      )) as unknown as OptionRow[],
  });
}

export function OptionListsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rows = useOptionRows();
  const [listKey, setListKey] = useState<ListKey>('complaint_type');
  const [draft, setDraft] = useState('');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['option-lists-admin'] });
    void qc.invalidateQueries({ queryKey: ['option-lists'] });
  };
  const fail = () =>
    toast.error(t('lists.saveError', { defaultValue: 'Could not save that change' }));

  const add = useMutation({
    mutationFn: (value: string) =>
      directus.request(
        createItem(
          'option_lists' as never,
          {
            list: listKey,
            value,
            sort: current.length,
            active: true,
          } as never,
        ),
      ),
    onSuccess: invalidate,
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<OptionRow> }) =>
      directus.request(updateItem('option_lists' as never, id, body as never)),
    onSuccess: invalidate,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('option_lists' as never, id)),
    onSuccess: invalidate,
    onError: fail,
  });

  const current = useMemo(
    () => (rows.data ?? []).filter((r) => r.list === listKey),
    [rows.data, listKey],
  );

  const LIST_LABELS: Record<ListKey, string> = {
    complaint_type: t('lists.complaintType', { defaultValue: 'Complaint type' }),
    service_type: t('lists.serviceType', { defaultValue: 'Service type' }),
    complaint_source: t('lists.complaintSource', { defaultValue: 'Complaint source' }),
    communication_method: t('lists.communicationMethod', { defaultValue: 'Communication method' }),
    compensation: t('lists.compensation', { defaultValue: 'Compensation' }),
  };

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    // The same value twice in one list is a data-entry accident, not a wish.
    if (current.some((r) => r.value.toLowerCase() === value.toLowerCase())) {
      toast.error(t('lists.duplicate', { defaultValue: 'That value is already on this list.' }));
      return;
    }
    add.mutate(value);
    setDraft('');
  };

  const move = (row: OptionRow, delta: number) => {
    const idx = current.findIndex((r) => r.id === row.id);
    if (idx < 0 || !current[idx + delta]) return;
    /**
     * Rewrite the WHOLE list's sorts from the new visual order, not a
     * two-row swap: after a retire/delete two rows can share a sort value,
     * and swapping equal numbers moves nothing while looking like it worked.
     * Renumbering 0..n makes every move land and self-heals old collisions.
     */
    const next = [...current];
    const [moved] = next.splice(idx, 1);
    next.splice(idx + delta, 0, moved!);
    next.forEach((r, i) => {
      if (r.sort !== i) patch.mutate({ id: r.id, body: { sort: i } });
    });
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('lists.title', { defaultValue: 'Dropdown lists' })}
        </h1>
        <ToolbarSpacer />
        <SelectMenu
          size="sm"
          className="w-[14rem]"
          value={listKey}
          onChange={(v) => setListKey(v as ListKey)}
          aria-label={t('lists.pickList', { defaultValue: 'List' })}
          options={LIST_KEYS.map((k) => ({ value: k, label: LIST_LABELS[k] }))}
        />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('lists.help', {
              defaultValue:
                'These values feed the complaint form live — no deploy needed. Retire a value to stop offering it; tickets that already carry it keep displaying it. The exact spellings are what reports group by, so a corrected spelling is a new value, not an edit.',
            })}
          </p>

          <div className="flex gap-2 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder={t('lists.addPlaceholder', {
                defaultValue: 'New value for this list…',
              })}
              aria-label={t('lists.addLabel', { defaultValue: 'New value' })}
            />
            <Button onClick={submit} disabled={!draft.trim() || add.isPending}>
              {t('lists.add', { defaultValue: 'Add' })}
            </Button>
          </div>

          {rows.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <ul className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              {current.map((row, i) => (
                <li
                  key={row.id}
                  className={cn(
                    'flex items-center gap-2 border-b border-border/60 px-4 py-2.5 last:border-b-0',
                    !row.active && 'opacity-60',
                  )}
                >
                  <span className="w-6 shrink-0 text-end text-2xs tabular-nums text-muted-foreground/70">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {row.value}
                  </span>
                  {!row.active && (
                    <Pill tone="neutral" size="sm">
                      {t('lists.retired', { defaultValue: 'Retired' })}
                    </Pill>
                  )}
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(row, -1)}
                    aria-label={t('lists.moveUp', {
                      value: row.value,
                      defaultValue: 'Move {{value}} up',
                    })}
                    className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-secondary hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === current.length - 1}
                    onClick={() => move(row, 1)}
                    aria-label={t('lists.moveDown', {
                      value: row.value,
                      defaultValue: 'Move {{value}} down',
                    })}
                    className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-secondary hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => patch.mutate({ id: row.id, body: { active: !row.active } })}
                  >
                    {row.active
                      ? t('lists.retire', { defaultValue: 'Retire' })
                      : t('lists.restore', { defaultValue: 'Restore' })}
                  </Button>
                  {/* Hard delete is for typos caught immediately — quiet on
                      purpose, since Retire is almost always the right call. */}
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          t('lists.deleteConfirm', {
                            value: row.value,
                            defaultValue:
                              'Delete “{{value}}” outright? Retiring is safer — tickets already carrying it keep displaying it either way.',
                          }),
                        )
                      )
                        remove.mutate(row.id);
                    }}
                    aria-label={t('lists.delete', {
                      value: row.value,
                      defaultValue: 'Delete {{value}}',
                    })}
                    className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-destructive/10 hover:text-destructive"
                  >
                    ✕
                  </button>
                </li>
              ))}
              {current.length === 0 && (
                <li className="p-8 text-center text-sm text-muted-foreground">
                  {t('lists.empty', { defaultValue: 'This list has no values yet.' })}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
