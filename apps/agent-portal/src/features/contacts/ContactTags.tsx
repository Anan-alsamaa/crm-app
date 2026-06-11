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
export function ContactTags({ contact }: { contact: ContactRow }) {
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
    <section className="rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04]">
      <h2 className="mb-3 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('sidebar.tags')}
      </h2>

      {assigned.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {assigned.map((j) => (
            <span
              key={j.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-1 ps-2 pe-1 text-xs font-medium text-foreground"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: j.tags_id!.color ?? '#94a3b8' }}
              />
              <span className="max-w-[10rem] truncate">{j.tags_id!.name}</span>
              <button
                type="button"
                onClick={() => void unassign(j.id)}
                aria-label={t('conversation.removeTag', {
                  defaultValue: `Remove ${j.tags_id!.name}`,
                  name: j.tags_id!.name,
                })}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-foreground/10 hover:text-foreground"
              >
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        !adding && (
          <p className="text-xs text-muted-foreground">
            {t('conversation.noTagsYet', { defaultValue: 'No tags yet.' })}
          </p>
        )
      )}

      <div className="mt-2.5">
        {adding ? (
          <div className="rounded-xl bg-secondary/40 p-1.5 ring-1 ring-foreground/[0.05]">
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
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background/80 px-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={closeEditor}
                className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-2xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-foreground transition-colors duration-fast hover:bg-secondary"
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: tg.color ?? '#94a3b8' }}
                  />
                  <span className="truncate">{tg.name}</span>
                </button>
              ))}
              {query.trim() && !exactMatch && (
                <button
                  type="button"
                  onClick={() => void createAndAssign()}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-foreground transition-colors duration-fast hover:bg-secondary"
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
                <p className="px-2 py-1.5 text-2xs text-muted-foreground">
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
            className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground transition-colors duration-fast ease-out hover:border-primary/40 hover:text-foreground"
          >
            <span className="text-sm leading-none">+</span>
            <span>{t('conversation.addTag', { defaultValue: 'Add tag' })}</span>
          </button>
        )}
      </div>
    </section>
  );
}
