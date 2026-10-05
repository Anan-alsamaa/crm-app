import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { Button, ConfirmDialog, Input, Pill, SavedTick, cn, toast } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * The ready wordings an agent inserts with one click — all three libraries.
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
 *
 * As of 2026-10-04 the collection carries a `kind`, so this one section edits
 * THREE isolated libraries rather than one shared list (see `KINDS` below).
 * Without it operations could not author a late-order reason or action at all —
 * the two boxes were shipped to the agent portal reading a column nothing in
 * any portal could write.
 */

/**
 * THREE LIBRARIES, NOT ONE LIST (ops, 2026-10-04: *"the values in reason and
 * action taken are new and isolated from each other and the inbox quick
 * replies"*).
 *
 * `chat` is the inbox composer's row, which is all this collection ever held.
 * The two `late_order_*` sets feed the Reason and Action-taken boxes on a
 * late-order decision. A reason explains why an order was late and an action
 * says what was done about it; neither is addressed to a customer, so pooling
 * them would offer an agent mostly wrong wordings in all three places.
 *
 * The literal strings are duplicated from the agent portal's `QuickReplyKind`
 * rather than imported: the two portals do not share a module here, and the
 * column's own `choices` in `directus/bootstrap/src/collections.ts` is the
 * third copy. Changing one means changing all three.
 */
const KINDS = ['chat', 'late_order_reason', 'late_order_action'] as const;
type ReplyKind = (typeof KINDS)[number];

/**
 * Rows written before the column existed have no `kind` at all, and they came
 * from the chat library — the only one that existed. Read as `chat`
 * everywhere, exactly as the agent portal's `useQuickReplies` does, so an
 * environment where the field has not been created yet still shows operations
 * their inbox replies instead of an empty page.
 */
export const kindOf = (r: { kind?: string | null }): ReplyKind =>
  (KINDS as readonly string[]).includes(r.kind ?? '') ? (r.kind as ReplyKind) : 'chat';

/**
 * IS THIS LABEL ALREADY TAKEN — IN THE LIBRARY IT IS GOING INTO?
 *
 * Scoped per `kind`, and that scoping is the whole point: "Compensated" is a
 * perfectly good ACTION and a perfectly good chat reply, and a global check
 * would refuse the second one for colliding with a row in a list nobody was
 * looking at.
 *
 * Checked against the DESTINATION kind, not the row's current one: moving
 * "Opening" into the reasons must collide with an existing reason, and must NOT
 * collide with the chat reply it is leaving behind.
 *
 * `excludeId` is the row being edited — renaming something to its own current
 * label is leaving it alone, not a duplicate.
 *
 * Exported so the rule is tested on its own. It is three conditions that have
 * to agree, and getting any of them wrong rejects an edit an operator is
 * entitled to make, which reads as the form being broken.
 */
export function labelTaken(
  rows: ReadonlyArray<{ id: string; label: string; kind?: string | null }>,
  label: string,
  destinationKind: ReplyKind,
  excludeId?: string,
): boolean {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return false;
  return rows.some(
    (r) => r.id !== excludeId && kindOf(r) === destinationKind && r.label.toLowerCase() === wanted,
  );
}

interface ReplyRow {
  id: string;
  label: string;
  text: string;
  lang: string | null;
  sort: number | null;
  active: boolean;
  kind?: string | null;
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
            /*
             * `kind` is READ but never FILTERED ON, the same contract the agent
             * portal's reader documents at length: Directus 403s a WHOLE query
             * that names a column the collection does not have, and a schema
             * field does not travel through a deploy. Asking for the field on
             * an environment without it yields rows whose `kind` is undefined,
             * which `kindOf` reads as `chat`; filtering on it server-side would
             * instead make this editor return nothing, which looks exactly like
             * "operations have not written any replies".
             */
            fields: ['id', 'label', 'text', 'lang', 'sort', 'active', 'kind'],
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
   * WHICH LIBRARY IS OPEN — a segmented filter scoping the whole section, not a
   * per-row dropdown and not three stacked lists.
   *
   * Chosen because everything below it already assumes it is looking at ONE
   * ordered list: the add form appends at `list.length`, the drag handler
   * renumbers `sort` from the visible order, and the numbered badge on each row
   * is its position. With three kinds pooled into one list all three of those
   * become wrong — a reason dragged above a chat reply would renumber the
   * inbox, and the badge would count rows the agent portal will never put side
   * by side. Scoping the list instead keeps those three contracts correct with
   * no change to them: each library gets its own 1..n ordering, which is what
   * the agent portal reads back per `kind`.
   *
   * It also answers the thing operations came here to do. They are not browsing
   * all three; they are writing the reasons, or the actions, or the replies. So
   * the filter doubles as the add form's target — whatever is selected is what
   * a new entry is written into — which is why there is no separate "kind"
   * select next to the language one.
   *
   * Defaults to `chat`: the inbox library is the one that already existed and
   * the one with rows in it, so an operator who opens this page sees exactly
   * what they saw before the column was added.
   */
  const [kind, setKind] = useState<ReplyKind>('chat');
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
  /**
   * The library is EDITABLE, not just displayed. A wording typed into the wrong
   * tab is the obvious data-entry accident here, and without this the only
   * remedy is to delete it and retype it in the right place — which is the same
   * "retyping loses its place in the order" complaint that put an edit dialog
   * on this section in the first place.
   */
  const [editKind, setEditKind] = useState<ReplyKind>('chat');
  const [deleting, setDeleting] = useState<ReplyRow | null>(null);

  const openEdit = (r: ReplyRow) => {
    setEditing(r);
    setEditLabel(r.label);
    setEditText(r.text);
    setEditLang(r.lang ?? 'en');
    setEditKind(kindOf(r));
  };
  const closeEdit = () => setEditing(null);
  const commitEdit = () => {
    if (!editing) return;
    const l = editLabel.trim();
    const x = editText.trim();
    /* Either field blank would render as an empty button, or a button that
       inserts nothing — both look broken in the inbox. */
    if (!l || !x) return;
    /*
     * Renaming onto ANOTHER entry's button is the same collision the add form
     * refuses; renaming to your own current label is just leaving it alone.
     *
     * Checked against the library this entry is being saved INTO — `editKind`,
     * not the tab that is open and not the kind it had before. Moving "Opening"
     * from the chat replies into the reasons has to collide with an existing
     * reason called "Opening" and must not collide with the chat reply it is
     * leaving behind.
     */
    if (labelTaken(all, l, editKind, editing.id)) {
      toast.error(
        t('replies.duplicate', { defaultValue: 'A reply with that button already exists.' }),
      );
      return;
    }
    /*
     * MOVED TO ANOTHER LIBRARY, so it needs a place in that one's order.
     *
     * Its old `sort` was a position among its old siblings and means nothing
     * here — keeping it would drop the entry into the middle of a list it has
     * never been in. Appended at the end instead, which is where the add form
     * puts a new one, and the gap it leaves behind is harmless: `sort` only
     * ever has to ORDER a library, never be dense.
     */
    const moved = editKind !== kindOf(editing);
    patch.mutate({
      id: editing.id,
      body: {
        label: l,
        text: x,
        lang: editLang,
        kind: editKind,
        ...(moved ? { sort: all.filter((r) => kindOf(r) === editKind).length } : {}),
      },
    });
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

  /**
   * `all` is every row, `list` is the open library.
   *
   * Both are needed and they are not interchangeable: the rendered list, the
   * ordering and the add form are all per-library, while the duplicate check
   * and the counts on the tabs have to see rows the open tab is hiding —
   * otherwise saving a reason called "Opening" would silently succeed against
   * a reason of that name sitting one tab away.
   */
  const all = rows.data ?? [];
  const list = all.filter((r) => kindOf(r) === kind);
  /** How many entries each library holds, shown on its tab. An empty library is
      a real state here — two of the three start empty — so the number is what
      tells operations whether the late-order boxes will offer anything. */
  const counts = Object.fromEntries(
    KINDS.map((k) => [k, all.filter((r) => kindOf(r) === k).length]),
  ) as Record<ReplyKind, number>;

  /** Renumber from a new visual order — the same contract as the option lists.
      Both ids come from `list`, so a drag can only ever reorder WITHIN the open
      library, which is the only place the order means anything. */
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
    /*
     * The button is what an agent scans for; two identical ones are a
     * data-entry accident, not a wish.
     *
     * Scoped to the SAME library (ops, 2026-10-04). Refusing a label that
     * exists anywhere was right while there was one list and is wrong now:
     * "Opening" is a perfectly good chat reply AND a perfectly good late-order
     * reason, the agent never sees the two together, and a blanket check would
     * have operations inventing second names for wordings that do not clash.
     * `list` is already the open library, so this reads as the scope it is.
     */
    if (list.some((r) => r.label.toLowerCase() === l.toLowerCase())) {
      toast.error(
        t('replies.duplicate', { defaultValue: 'A reply with that button already exists.' }),
      );
      return;
    }
    /* `kind` is the open tab: the filter above doubles as this form's target,
       so there is nothing extra to choose and nothing to get out of step with
       the list the new entry is about to appear in. */
    add.mutate({ label: l, text: x, lang, kind, sort: list.length, active: true });
    setLabel('');
    setText('');
  };

  /*
   * WHAT EACH LIBRARY IS CALLED, and the sentence explaining where it shows up.
   *
   * Written per kind rather than as one generic "ready replies" heading,
   * because the whole point of splitting the collection is that these are three
   * different jobs. An operator filling the Reason box needs to be told it
   * appears on a late-order decision, not above a composer — the agent portal
   * relabels its own button for exactly this reason.
   */
  const kindLabel = (k: ReplyKind) =>
    k === 'late_order_reason'
      ? t('replies.kind.late_order_reason', { defaultValue: 'Late orders: Reason' })
      : k === 'late_order_action'
        ? t('replies.kind.late_order_action', { defaultValue: 'Late orders: Action taken' })
        : t('replies.kind.chat', { defaultValue: 'Inbox: Quick replies' });

  const kindHint =
    kind === 'late_order_reason'
      ? t('replies.hintReasons', {
          defaultValue:
            'Ready wordings for the Reason box on a late-order decision — why the order was late. The button is what the agent sees; the text is what gets inserted. Drag to reorder.',
        })
      : kind === 'late_order_action'
        ? t('replies.hintActions', {
            defaultValue:
              'Ready wordings for the Action taken box on a late-order decision — what was done about it. The button is what the agent sees; the text is what gets inserted. Drag to reorder.',
          })
        : t('replies.hint', {
            defaultValue:
              'The buttons above the reply box in the inbox. The button is what the agent sees; the text is what gets inserted. Drag to reorder.',
          });

  /* The body placeholder, per library. "What gets inserted into the reply box"
     is a lie under the Reasons tab — nothing there goes into a reply box — and
     a placeholder that describes the wrong field is how an operator ends up
     writing a sentence addressed to a customer into a reason. */
  const textPlaceholderFor = (k: ReplyKind) =>
    k === 'late_order_reason'
      ? t('replies.textPlaceholderReason', {
          defaultValue: 'What gets inserted into the Reason box...',
        })
      : k === 'late_order_action'
        ? t('replies.textPlaceholderAction', {
            defaultValue: 'What gets inserted into the Action taken box...',
          })
        : t('replies.textPlaceholder', {
            defaultValue: 'What gets inserted into the reply box...',
          });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 pb-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {kindLabel(kind)}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{kindHint}</p>
        </div>
        <SavedTick
          saved={patch.isSuccess || add.isSuccess || remove.isSuccess}
          label={t('actions.saved', { ns: 'common', defaultValue: 'Saved' })}
        />
      </div>

      {/* THE LIBRARY PICKER — the coupon board's pill-filter idiom, so the two
          pages agree about what "a filter above a list" looks like. The count
          is on the tab deliberately: two of the three libraries start empty and
          an operator has to be able to see that from here, without clicking
          through and reading an empty state three times. */}
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={t('replies.kindFilter', { defaultValue: 'Which library' })}
      >
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-out',
              kind === k
                ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                : 'bg-secondary/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {kindLabel(k)}
            <span className="ms-1.5 tabular-nums opacity-60">{counts[k]}</span>
          </button>
        ))}
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
          {/*
            A TEXTAREA, matching the edit row (owner, 2026-09-30).

            This was an `<Input>`, which cannot hold a newline at all: an agent
            pasting a three-line reply got one line, and the breaks were gone
            before anything was saved. Editing the same reply preserved them,
            because that row has always been a textarea — so the two halves of
            one feature disagreed about what a quick reply is.

            `Enter` no longer submits, for the same reason: in a multi-line box
            it must make a line. Ctrl/Cmd+Enter submits instead, which is the
            convention the reply composer already uses.
          */}
          <textarea
            dir="auto"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={textPlaceholderFor(kind)}
            aria-label={t('replies.text', { defaultValue: 'Reply text' })}
            className="w-full resize-y rounded-xl bg-secondary/40 px-3 py-2 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
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
        /* Names the library, because "No ready replies yet" under a Reasons tab
           reads as though the page lost its filter. It is also the expected
           state for the two late-order libraries on day one, so it must not
           look like a fault. */
        <p className="px-1 text-sm text-muted-foreground">
          {t('replies.noneInKind', {
            kind: kindLabel(kind),
            defaultValue: 'Nothing in “{{kind}}” yet. Add the first one above.',
          })}
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
                /* Follows the library this entry is being saved INTO, so moving
                   a chat reply to the reasons re-describes the box as you do
                   it. */
                placeholder={textPlaceholderFor(editKind)}
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
            {/* THE LIBRARY — last, because it is the field nobody changes. It is
                here so a wording filed under the wrong tab can be moved instead
                of deleted and retyped; saving it re-scopes the duplicate check
                and appends it to the destination's order. */}
            <label className="block space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('replies.kindFilter', { defaultValue: 'Which library' })}
              </span>
              <select
                value={editKind}
                onChange={(e) => setEditKind(e.target.value as ReplyKind)}
                className="h-10 w-full rounded-xl bg-secondary/40 px-3 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
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
