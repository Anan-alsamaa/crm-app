import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, toast } from '@yiji/ui';
import { useTags, useCreateTag } from '../inbox/api.js';
import { useAddTagToContact, useRemoveTagFromContact, type ContactRow } from './api.js';

/**
 * Tags for a contact — chips with an inline search-or-create editor, mirroring
 * the conversation tag editor. Uses the shared tags library (create reuses an
 * existing tag by name) via the contacts_tags junction.
 */
export function ContactTags({
  contact,
  readOnly = false,
}: {
  contact: ContactRow;
  /** Chips only, no add/remove — the caller lacks `edit_contacts` (owner, 2026-10-06). */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const tags = useTags();
  const createTag = useCreateTag();
  const addTag = useAddTagToContact();
  const removeTag = useRemoveTagFromContact();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const assigned = contact.tags?.filter((j) => j.tags_id) ?? [];
  const assignedIds = new Set(assigned.map((j) => j.tags_id!.id));
  const q = query.trim().toLowerCase();
  const available = (tags.data ?? [])
    .filter((tg) => !assignedIds.has(tg.id))
    .filter((tg) => tg.name.toLowerCase().includes(q));
  const exactMatch = (tags.data ?? []).some((tg) => tg.name.toLowerCase() === q);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const closeEditor = () => {
    setAdding(false);
    setQuery('');
  };
  const assign = async (tagId: string) => {
    try {
      await addTag.mutateAsync({ contactId: contact.id, tagId });
      setQuery('');
      inputRef.current?.focus();
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const createAndAssign = async () => {
    const name = query.trim();
    if (!name) return;
    try {
      const existing = (tags.data ?? []).find((tg) => tg.name.toLowerCase() === name.toLowerCase());
      if (existing && assignedIds.has(existing.id)) {
        setQuery('');
        return;
      }
      const tagId = existing ? existing.id : (await createTag.mutateAsync({ name })).id;
      await addTag.mutateAsync({ contactId: contact.id, tagId });
      setQuery('');
      inputRef.current?.focus();
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const unassign = async (junctionId: string) => {
    try {
      await removeTag.mutateAsync({ junctionId, contactId: contact.id });
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  return (
    <section className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06] shadow-soft">
      <h2 className="mb-3.5 text-md font-semibold text-foreground">{t('sidebar.tags')}</h2>

      {assigned.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {assigned.map((j) => (
            <span
              key={j.id}
              className="inline-flex h-8 items-center gap-2 rounded-full bg-foreground/[0.05] pe-1.5 ps-3 text-xs font-semibold text-foreground"
            >
              <span
                aria-hidden
                // Token fallback (not a hex literal) so a colorless tag still
                // reads correctly on both themes; a stored color overrides it.
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
                style={j.tags_id!.color ? { background: j.tags_id!.color } : undefined}
              />
              <span className="max-w-[10rem] truncate">{j.tags_id!.name}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void unassign(j.id)}
                  aria-label={t('conversation.removeTag', {
                    defaultValue: `Remove ${j.tags_id!.name}`,
                    name: j.tags_id!.name,
                  })}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        !adding && (
          <p className="rounded-2xl bg-foreground/[0.035] px-4 py-3.5 text-center text-xs text-muted-foreground">
            {t('conversation.noTagsYet', { defaultValue: 'No tags yet.' })}
          </p>
        )
      )}

      {!readOnly && (
        <div className="mt-3">
          {adding ? (
            <div className="rounded-2xl bg-input p-1.5 ring-1 ring-inset ring-foreground/[0.08] transition-shadow duration-fast focus-within:ring-2 focus-within:ring-primary/40">
              <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (query.trim()) void createAndAssign();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      closeEditor();
                    }
                  }}
                  placeholder={t('conversation.tagSearchPlaceholder', {
                    defaultValue: 'Search or create…',
                  })}
                  aria-label={t('conversation.tagSearchPlaceholder', {
                    defaultValue: 'Search or create a tag',
                  })}
                  className="h-9 min-w-0 flex-1 rounded-xl border-none bg-transparent px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:shadow-none"
                />
                <button
                  type="button"
                  onClick={closeEditor}
                  data-text-action=""
                  className="h-8 shrink-0 text-xs font-semibold"
                >
                  {t('actions.done', { ns: 'common', defaultValue: 'Done' })}
                </button>
              </div>
              <div className="mt-1 max-h-48 overflow-auto">
                {available.map((tg) => (
                  <button
                    key={tg.id}
                    type="button"
                    onClick={() => void assign(tg.id)}
                    className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start text-sm text-foreground transition-colors duration-fast hover:bg-primary/[0.06] focus-visible:bg-primary/[0.06] focus-visible:outline-none"
                  >
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
                      style={tg.color ? { background: tg.color } : undefined}
                    />
                    <span className="truncate">{tg.name}</span>
                  </button>
                ))}
                {query.trim() && !exactMatch && (
                  <button
                    type="button"
                    onClick={() => void createAndAssign()}
                    className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start text-sm text-foreground transition-colors duration-fast hover:bg-primary/[0.06] focus-visible:bg-primary/[0.06] focus-visible:outline-none"
                  >
                    <span className="text-sm leading-none text-primary">+</span>
                    <span className="truncate">
                      {t('conversation.createTagNamed', {
                        name: query.trim(),
                        defaultValue: `Create “${query.trim()}”`,
                      })}
                    </span>
                  </button>
                )}
                {available.length === 0 && !query.trim() && (
                  <p className="px-2.5 py-2 text-xs text-muted-foreground">
                    {t('conversation.allTagsAdded', {
                      defaultValue: 'All tags added — type to create a new one.',
                    })}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3.5 text-xs font-semibold text-primary transition-colors duration-fast ease-out hover:bg-primary/[0.17] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="text-sm leading-none">+</span>
              <span>{t('conversation.addTag', { defaultValue: 'Add tag' })}</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
