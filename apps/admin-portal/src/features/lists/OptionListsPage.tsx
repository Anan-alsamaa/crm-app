import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ChevronDownIcon,
  CloseIcon,
  EmptyState,
  IconButton,
  Input,
  Pill,
  SectionCard,
  SelectMenu,
  SettingsIcon,
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
          {/* Page hero — the boards' header anatomy, same as every sibling
              page, so the suite reads as one product. */}
          <div className="border-b border-foreground/10 pb-5">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {t('lists.title', { defaultValue: 'Dropdown lists' })}
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('lists.heroSubtitle', {
                defaultValue:
                  'Every dropdown the ticket form offers, editable live. Pick a list, then add, reorder, retire, or restore its values.',
              })}
            </p>
          </div>
          {/* The board card header carries the list's name and the one rule an
              operator must know before touching it. */}
          {/* The count lives in the board card's footer band below — a bare
              numeral floating beside the header read as debris. */}
          <SectionCard
            title={LIST_LABELS[listKey]}
            hint={t('lists.help', {
              defaultValue:
                'These values feed the complaint form live — no deploy needed. Retire a value to stop offering it; tickets that already carry it keep displaying it. The exact spellings are what reports group by, so a corrected spelling is a new value, not an edit.',
            })}
          >
            <div className="flex gap-2">
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
          </SectionCard>

          {rows.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            /* Rows flush inside one board card — hairline separators, then a
               footer aggregate band, per the boards' table anatomy. */
            <div className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              <ul className="divide-y divide-foreground/[0.06]">
                {current.map((row, i) => (
                  <li
                    key={row.id}
                    className={cn(
                      'flex items-center gap-2 px-4 py-2.5',
                      !row.active && 'opacity-60',
                    )}
                  >
                    {/* Numbered chip — the row's rank in the dropdown, as a tile. */}
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-secondary text-2xs font-semibold tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {row.value}
                    </span>
                    {!row.active && (
                      <Pill tone="neutral" size="sm">
                        {t('lists.retired', { defaultValue: 'Retired' })}
                      </Pill>
                    )}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      disabled={i === 0}
                      onClick={() => move(row, -1)}
                      aria-label={t('lists.moveUp', {
                        value: row.value,
                        defaultValue: 'Move {{value}} up',
                      })}
                    >
                      <ChevronDownIcon size={14} className="rotate-180" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      disabled={i === current.length - 1}
                      onClick={() => move(row, 1)}
                      aria-label={t('lists.moveDown', {
                        value: row.value,
                        defaultValue: 'Move {{value}} down',
                      })}
                    >
                      <ChevronDownIcon size={14} />
                    </IconButton>
                    {/* Hairline divider groups the reorder pair apart from the
                        lifecycle actions, so the cluster reads as two verbs. */}
                    <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-foreground/[0.08]" />
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
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              {current.length === 0 && (
                /* Composed empty state — an icon chip and a real title, never
                   a bare text line floating in dead space. */
                <EmptyState
                  icon={<SettingsIcon size={20} />}
                  title={t('lists.empty', { defaultValue: 'This list has no values yet.' })}
                  description={t('lists.emptyHint', {
                    defaultValue:
                      'Add the first value above — the form offers it as soon as it saves.',
                  })}
                />
              )}
              {/* Footer aggregate band — the boards' table anatomy. */}
              <div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] bg-secondary/30 px-4 py-2.5">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('lists.valuesCap', { defaultValue: 'values' })}
                </span>
                <span className="text-sm font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
                  {current.length}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
