import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { Button, ConfirmDialog, Input, Pill, SavedTick, cn, toast } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * The ready replies an agent clicks above the composer.
 *
 * They already existed and were already used in the inbox — but only editable
 * by someone with a Directus login, which means in practice they were never
 * edited. A supervisor who wants to change what their team says to customers
 * should not need database access.
 *
 * Deliberately on the Dropdown values page rather than a page of its own: it is
 * the same kind of thing, a list of wordings operations owns, and someone
 * looking for "what can we change without a deploy" should find it all in one
 * place.
 */
interface ReplyRow {
  id: string;
  label: string;
  text: string;
  lang: string | null;
  sort: number | null;
  active: boolean;
}

function useReplies() {
  return useQuery({
    queryKey: ['quick-replies-admin'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'quick_replies' as never,
          {
            limit: -1,
            sort: ['sort', 'label'],
            fields: ['id', 'label', 'text', 'lang', 'sort', 'active'],
          } as never,
        ),
      )) as unknown as ReplyRow[],
  });
}

export function QuickRepliesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rows = useReplies();
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [lang, setLang] = useState('en');
  const [dragId, setDragId] = useState<string | null>(null);
  /**
   * EDIT and DELETE, both in an in-app dialog.
   *
   * There was no edit at all: changing a wording meant deleting the reply and
   * retyping it, which loses its place in the order and its language. And a
   * reply is two fields — the button an agent scans for and the text that gets
   * inserted — so a one-line `window.prompt` could never have served it
   * (owner, 2026-09-24).
   */
  const [editing, setEditing] = useState<ReplyRow | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editText, setEditText] = useState('');
  const [editLang, setEditLang] = useState('en');
  const [deleting, setDeleting] = useState<ReplyRow | null>(null);

  const openEdit = (r: ReplyRow) => {
    setEditing(r);
    setEditLabel(r.label);
    setEditText(r.text);
    setEditLang(r.lang ?? 'en');
  };
  const closeEdit = () => setEditing(null);
  const commitEdit = () => {
    if (!editing) return;
    const l = editLabel.trim();
    const x = editText.trim();
    /* Either field blank would render as an empty button, or a button that
       inserts nothing — both look broken in the inbox. */
    if (!l || !x) return;
    // Renaming onto ANOTHER reply's button is the same collision the add form
    // refuses; renaming to your own current label is just leaving it alone.
    if (list.some((r) => r.id !== editing.id && r.label.toLowerCase() === l.toLowerCase())) {
      toast.error(
        t('replies.duplicate', { defaultValue: 'A reply with that button already exists.' }),
      );
      return;
    }
    patch.mutate({ id: editing.id, body: { label: l, text: x, lang: editLang } });
    closeEdit();
  };

  const done = () => void qc.invalidateQueries({ queryKey: ['quick-replies-admin'] });
  const fail = () => toast.error(t('errors.updateFailed', { ns: 'common' }));

  const add = useMutation({
    mutationFn: (body: Omit<ReplyRow, 'id'>) =>
      directus.request(createItem('quick_replies' as never, body as never)),
    onSuccess: done,
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<ReplyRow> }) =>
      directus.request(updateItem('quick_replies' as never, id, body as never)),
    onSuccess: done,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('quick_replies' as never, id)),
    onSuccess: done,
    onError: fail,
  });

  const list = rows.data ?? [];

  /** Renumber from a new visual order — the same contract as the option lists. */
  const moveTo = (fromId: string, toId: string) => {
    const from = list.findIndex((r) => r.id === fromId);
    const to = list.findIndex((r) => r.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    next.forEach((r, i) => {
      if (r.sort !== i) patch.mutate({ id: r.id, body: { sort: i } });
    });
  };

  const submit = () => {
    const l = label.trim();
    const x = text.trim();
    if (!l || !x) return;
    // The button is what an agent scans for; two identical ones are a
    // data-entry accident, not a wish.
    if (list.some((r) => r.label.toLowerCase() === l.toLowerCase())) {
      toast.error(
        t('replies.duplicate', { defaultValue: 'A reply with that button already exists.' }),
      );
      return;
    }
    add.mutate({ label: l, text: x, lang, sort: list.length, active: true });
    setLabel('');
    setText('');
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 pb-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('replies.title', { defaultValue: 'Inbox: ready replies' })}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t('replies.hint', {
              defaultValue:
                'The buttons above the reply box in the inbox. The button is what the agent sees; the text is what gets inserted. Drag to reorder.',
            })}
          </p>
        </div>
        <SavedTick
          saved={patch.isSuccess || add.isSuccess || remove.isSuccess}
          label={t('actions.saved', { ns: 'common', defaultValue: 'Saved' })}
        />
      </div>

      {/* Add: button, wording, language — in the order they are read. */}
      <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_5.5rem_auto]">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('replies.labelPlaceholder', { defaultValue: 'Button, e.g. Opening' })}
            aria-label={t('replies.label', { defaultValue: 'Button' })}
          />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={t('replies.textPlaceholder', {
              defaultValue: 'What gets inserted into the reply box...',
            })}
            aria-label={t('replies.text', { defaultValue: 'Reply text' })}
          />
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label={t('replies.lang', { defaultValue: 'Language' })}
            className="h-10 rounded-xl bg-secondary/40 px-3 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="en">EN</option>
            <option value="ar">AR</option>
          </select>
          <Button type="button" onClick={submit} disabled={!label.trim() || !text.trim()}>
            {t('actions.add', { ns: 'common', defaultValue: 'Add' })}
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          {t('replies.none', { defaultValue: 'No ready replies yet.' })}
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
          <ul className="divide-y divide-foreground/[0.06]">
            {list.map((r, i) => (
              <li
                key={r.id}
                draggable
                onDragStart={(e) => {
                  setDragId(r.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) moveTo(dragId, r.id);
                  setDragId(null);
                }}
                className={cn(
                  'flex cursor-grab items-center gap-3 px-4 py-3 active:cursor-grabbing',
                  'transition-colors duration-fast ease-out hover:bg-secondary/40',
                  !r.active && 'opacity-60',
                  dragId === r.id && 'opacity-40',
                )}
              >
                <span
                  aria-hidden
                  className="shrink-0 select-none text-xs leading-none text-muted-foreground/50"
                >
                  ...
                </span>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-secondary text-2xs font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {r.label}
                  </span>
                  <span dir="auto" className="block truncate text-xs text-muted-foreground">
                    {r.text}
                  </span>
                </span>
                <Pill tone="neutral" size="sm">
                  {(r.lang ?? 'en').toUpperCase()}
                </Pill>
                {/* The same three verbs as the option lists, in the same order,
                    so the two halves of this page behave alike. */}
                <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                  {t('lists.edit', { defaultValue: 'Edit' })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patch.mutate({ id: r.id, body: { active: !r.active } })}
                >
                  {r.active
                    ? t('lists.retire', { defaultValue: 'Retire' })
                    : t('lists.restore', { defaultValue: 'Restore' })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setDeleting(r)}
                >
                  {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* EDIT — both fields, plus the language, in the order they are read. */}
      <ConfirmDialog
        open={!!editing}
        title={t('replies.editTitle', { defaultValue: 'Edit this ready reply' })}
        description={
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('replies.label', { defaultValue: 'Button' })}
              </span>
              <Input
                autoFocus
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder={t('replies.labelPlaceholder', {
                  defaultValue: 'Button, e.g. Opening',
                })}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('replies.text', { defaultValue: 'Reply text' })}
              </span>
              {/* A textarea, not an Input: these are sentences an agent sends to
                  a customer, and the add row's single line hid the end of them. */}
              <textarea
                dir="auto"
                rows={4}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                placeholder={t('replies.textPlaceholder', {
                  defaultValue: 'What gets inserted into the reply box...',
                })}
                className="w-full resize-y rounded-xl bg-secondary/40 px-3 py-2 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('replies.lang', { defaultValue: 'Language' })}
              </span>
              <select
                value={editLang}
                onChange={(e) => setEditLang(e.target.value)}
                className="h-10 w-full rounded-xl bg-secondary/40 px-3 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="en">EN</option>
                <option value="ar">AR</option>
              </select>
            </label>
          </div>
        }
        confirmLabel={t('actions.save', { ns: 'common', defaultValue: 'Save' })}
        loading={patch.isPending}
        onConfirm={commitEdit}
        onCancel={closeEdit}
      />

      {/* DELETE — destructive, and it names retiring as the softer option. */}
      <ConfirmDialog
        open={!!deleting}
        destructive
        title={t('replies.deleteTitle', {
          label: deleting?.label ?? '',
          defaultValue: 'Delete “{{label}}”?',
        })}
        description={t('replies.deleteConfirm', {
          defaultValue: 'Retiring stops offering it without losing the wording.',
        })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
