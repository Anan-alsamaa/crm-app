import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { Button, ConfirmDialog, Drawer, Input, Pill, cn, toast } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * KNOWLEDGE BASE for the AI auto-reply (owner, 2026-10-13;
 * docs/AI-AUTO-REPLY-PLAN.md). The ONLY thing the AI may answer from, besides
 * the customer's order: if an answer is not written here, the AI hands the
 * chat to an agent. One row = one topic (a question and its answer).
 */
interface Entry {
  id: string;
  title: string;
  content: string;
  lang: 'en' | 'ar';
  active: boolean;
  sort: number | null;
}

const KEY = ['ai-knowledge'];

export function KnowledgeBaseSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: () =>
      directus.request(
        readItems(
          'ai_knowledge' as never,
          {
            fields: ['id', 'title', 'content', 'lang', 'active', 'sort'],
            sort: ['sort', 'title'],
            limit: -1,
          } as never,
        ),
      ) as Promise<Entry[]>,
  });
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: unknown) =>
    toast.error(
      e instanceof Error ? e.message : t('kb.saveFailed', { defaultValue: 'Not saved.' }),
    );
  const save = useMutation({
    mutationFn: (e: Partial<Entry> & { id?: string }) =>
      e.id
        ? directus.request(updateItem('ai_knowledge' as never, e.id, e as never))
        : directus.request(createItem('ai_knowledge' as never, e as never)),
    onSuccess: () => {
      done();
      toast.success(t('kb.saved', { defaultValue: 'Saved.' }));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('ai_knowledge' as never, id)),
    onSuccess: done,
    onError: fail,
  });

  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const rows = list.data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('kb.title', { defaultValue: 'Knowledge base' })}
          </h2>
          <p className="text-sm text-foreground/80">
            {t('kb.hint', {
              defaultValue:
                'What the AI auto-reply may answer from: FAQs and policies. If an answer is not here, the AI hands the chat to an agent. It never offers coupons or compensation.',
            })}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setEditing({ title: '', content: '', lang: 'ar', active: true })}
        >
          {t('kb.add', { defaultValue: 'Add topic' })}
        </Button>
      </div>

      <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        {list.isError ? (
          <p className="p-5 text-sm text-destructive">
            {t('kb.loadFailed', { defaultValue: 'Could not load the knowledge base.' })}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            {list.isLoading
              ? '…'
              : t('kb.empty', {
                  defaultValue:
                    'No topics yet. With an empty knowledge base the AI hands every chat over.',
                })}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span dir="auto" className="truncate text-sm font-medium text-foreground">
                      {r.title}
                    </span>
                    <Pill size="sm" tone="neutral">
                      {r.lang === 'ar' ? 'AR' : 'EN'}
                    </Pill>
                    {!r.active && (
                      <Pill size="sm" tone="warning">
                        {t('kb.off', { defaultValue: 'Off' })}
                      </Pill>
                    )}
                  </div>
                  <p
                    dir="auto"
                    className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground"
                  >
                    {r.content}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  {t('kb.edit', { defaultValue: 'Edit' })}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                  {t('kb.delete', { defaultValue: 'Delete' })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <Drawer
          open
          onClose={() => setEditing(null)}
          title={
            editing.id
              ? t('kb.editTitle', { defaultValue: 'Edit topic' })
              : t('kb.addTitle', { defaultValue: 'Add topic' })
          }
          footer={
            <Button
              onClick={() => {
                if (!editing.title?.trim() || !editing.content?.trim()) {
                  toast.error(
                    t('kb.required', { defaultValue: 'A topic needs a title and an answer.' }),
                  );
                  return;
                }
                save.mutate({
                  ...(editing.id ? { id: editing.id } : {}),
                  title: editing.title.trim(),
                  content: editing.content.trim(),
                  lang: editing.lang ?? 'ar',
                  active: editing.active ?? true,
                });
                setEditing(null);
              }}
            >
              {t('kb.save', { defaultValue: 'Save' })}
            </Button>
          }
        >
          <div className="space-y-3 p-4">
            <Input
              dir="auto"
              value={editing.title ?? ''}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              aria-label={t('kb.topic', { defaultValue: 'Topic' })}
              placeholder={t('kb.topicHint', { defaultValue: 'e.g. Delivery areas' })}
            />
            <textarea
              dir="auto"
              rows={6}
              value={editing.content ?? ''}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              aria-label={t('kb.answer', { defaultValue: 'Answer' })}
              placeholder={t('kb.answerHint', { defaultValue: 'The answer the AI may give.' })}
              className={cn(
                'w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground ring-1 ring-border',
                'focus:outline-none focus:ring-2 focus:ring-primary/40',
              )}
            />
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t('kb.language', { defaultValue: 'Language' })}
                </span>
                <select
                  value={editing.lang ?? 'ar'}
                  onChange={(e) => setEditing({ ...editing, lang: e.target.value as 'en' | 'ar' })}
                  className="rounded-md bg-background px-2 py-1 ring-1 ring-border"
                >
                  <option value="ar">العربية</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.active ?? true}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                {t('kb.active', { defaultValue: 'In use' })}
              </label>
            </div>
          </div>
        </Drawer>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={t('kb.deleteTitle', { defaultValue: 'Delete this topic?' })}
        description={deleting?.title}
        confirmLabel={t('kb.delete', { defaultValue: 'Delete' })}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </section>
  );
}
