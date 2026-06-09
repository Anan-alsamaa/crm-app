import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, CloseIcon, toast } from '@yiji/ui';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import {
  useTags,
  useAddTagToConversation,
  useRemoveTagFromConversation,
  useCreateTag,
  type InboxConversation,
} from '../inbox/api.js';
import { getSocket } from '../../lib/socket.js';

/** A conversation can carry at most this many tags (also enforced in the DB). */
const MAX_TAGS = 5;

async function broadcastUpdate(conversationId: string): Promise<void> {
  const socket = await getSocket();
  socket.emit(SOCKET_EVENTS.conversationUpdated, { conversationId });
}

/**
 * Tag management for a conversation — the single home for tags, rendered in the
 * details sidebar. Assigned tags show as removable chips; an inline editor adds
 * or creates tags (inline, not a popover, so it never clips inside the scrolling
 * panel). Enforces the 5-tag cap with a clear count.
 */
export function ConversationTags({ conversation }: { conversation: InboxConversation }) {
  const { t } = useTranslation();
  const tags = useTags();
  const addTag = useAddTagToConversation();
  const removeTag = useRemoveTagFromConversation();
  const createTag = useCreateTag();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const assigned = conversation.tags?.filter((j) => j.tags_id) ?? [];
  const assignedIds = new Set(assigned.map((j) => j.tags_id!.id));
  const atMax = assigned.length >= MAX_TAGS;
  const q = query.trim().toLowerCase();
  const available = (tags.data ?? [])
    .filter((tg) => !assignedIds.has(tg.id))
    .filter((tg) => tg.name.toLowerCase().includes(q));
  const exactMatch = (tags.data ?? []).some((tg) => tg.name.toLowerCase() === q);
  const limitMsg = t('conversation.tagLimit', {
    count: MAX_TAGS,
    defaultValue: `Up to ${MAX_TAGS} tags per conversation.`,
  });

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const openEditor = () => {
    if (atMax) {
      toast.error(limitMsg);
      return;
    }
    setAdding(true);
  };
  const closeEditor = () => {
    setAdding(false);
    setQuery('');
  };

  const assign = async (tagId: string) => {
    if (atMax) {
      toast.error(limitMsg);
      return;
    }
    try {
      await addTag.mutateAsync({ conversationId: conversation.id, tagId });
      await broadcastUpdate(conversation.id);
      setQuery('');
      inputRef.current?.focus();
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const createAndAssign = async () => {
    const name = query.trim();
    if (!name || atMax) return;
    try {
      const existing = (tags.data ?? []).find((tg) => tg.name.toLowerCase() === name.toLowerCase());
      if (existing && assignedIds.has(existing.id)) {
        setQuery('');
        return;
      }
      const tagId = existing ? existing.id : (await createTag.mutateAsync({ name })).id;
      await addTag.mutateAsync({ conversationId: conversation.id, tagId });
      await broadcastUpdate(conversation.id);
      setQuery('');
      inputRef.current?.focus();
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const unassign = async (junctionId: string) => {
    try {
      await removeTag.mutateAsync({ junctionId, conversationId: conversation.id });
      await broadcastUpdate(conversation.id);
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  return (
    <div>
      {/* Label + count, matching the sidebar's other section headers. */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('sidebar.tags')}
        </h3>
        <span
          className={cn(
            'text-2xs font-semibold tabular-nums',
            atMax ? 'text-primary' : 'text-muted-foreground/70',
          )}
        >
          {assigned.length}/{MAX_TAGS}
        </span>
      </div>

      {/* Assigned chips — colour-dotted, removable on hover. */}
      {assigned.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {assigned.map((j) => (
            <span
              key={j.id}
              className="group/chip inline-flex items-center gap-1.5 rounded-full bg-secondary py-1 ps-2 pe-1 text-xs font-medium text-foreground"
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

      {/* Add / create — inline editor, never a clipped popover. */}
      <div className="mt-2.5">
        {atMax ? (
          <p className="text-2xs text-muted-foreground">{limitMsg}</p>
        ) : adding ? (
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
                    // createAndAssign resolves an exact existing name to that tag,
                    // otherwise creates it — so Enter does the right thing either way.
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

              {/* Create row — only when the typed name doesn't already exist. */}
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
            onClick={openEditor}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground transition-colors duration-fast ease-out hover:border-primary/40 hover:text-foreground"
          >
            <span className="text-sm leading-none">+</span>
            <span>{t('conversation.addTag')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
