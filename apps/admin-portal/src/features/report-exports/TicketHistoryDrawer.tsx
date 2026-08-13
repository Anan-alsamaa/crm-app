import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readRevisions } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { Drawer, Skeleton, cn } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * The full change history of one complaint, for the supervisor's eye: who
 * changed which field, from what, to what — plus who created it.
 *
 * Same source of truth as the agent portal's panel: Directus's own
 * activity + revisions, so imports and raw API writes appear with their
 * actor, which no client-side log could promise. Deletion audits outlive the
 * ticket, but a deleted ticket has no row to select — the story of deletions
 * lives in the activity trail, queried by id if ever needed.
 */
const NOISE = new Set([
  'date_updated',
  'user_updated',
  'date_created',
  'user_created',
  'id',
  'sort',
  // Frozen evidence blobs: a JSON diff of an order snapshot reads as garbage
  // and the columns themselves are immutable-by-policy anyway.
  'order_snapshot',
  'store_snapshot',
]);

interface RevisionRow {
  id: number;
  data: Record<string, unknown> | null;
  delta: Record<string, unknown> | null;
  activity: { id: number; action: string; timestamp: string; user: string | null } | null;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

function toEntries(revisions: RevisionRow[]) {
  const entries: Array<{
    id: number;
    action: string;
    timestamp: string;
    userId: string | null;
    changes: Array<{ field: string; from: string; to: string }>;
  }> = [];
  let prev: Record<string, unknown> | null = null;
  for (const rev of revisions) {
    const action = rev.activity?.action ?? 'update';
    const changes: Array<{ field: string; from: string; to: string }> = [];
    if (action === 'update') {
      for (const [field, next] of Object.entries(rev.delta ?? {})) {
        if (NOISE.has(field)) continue;
        const before = prev?.[field];
        if (show(before) === show(next)) continue;
        changes.push({ field, from: show(before), to: show(next) });
      }
      if (changes.length === 0) {
        prev = rev.data ?? prev;
        continue;
      }
    }
    entries.push({
      id: rev.id,
      action,
      timestamp: rev.activity?.timestamp ?? '',
      userId: rev.activity?.user ?? null,
      changes,
    });
    prev = rev.data ?? prev;
  }
  return entries.reverse();
}

export function TicketHistoryDrawer({
  ticketId,
  label,
  userNames,
  onClose,
}: {
  ticketId: string;
  /** What the drawer calls the ticket — complaint type, order number. */
  label: string;
  userNames: Map<string, string>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const revisions = useQuery({
    queryKey: ['admin-ticket-revisions', ticketId],
    queryFn: async () =>
      (await directus.request(
        readRevisions({
          filter: { collection: { _eq: 'tickets' }, item: { _eq: ticketId } },
          sort: ['id'],
          limit: -1,
          fields: ['id', 'data', 'delta', { activity: ['id', 'action', 'timestamp', 'user'] }],
        } as never),
      )) as unknown as RevisionRow[],
  });
  const entries = useMemo(() => toEntries(revisions.data ?? []), [revisions.data]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={t('complaintReport.historyTitle', {
        label,
        defaultValue: 'Change history — {{label}}',
      })}
    >
      <div className="space-y-3 p-4">
        {revisions.isLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('complaintReport.noHistory', {
              defaultValue: 'No changes recorded since this complaint was created.',
            })}
          </p>
        ) : (
          <ol className="space-y-3">
            {entries.map((e) => (
              <li key={e.id} className="rounded-xl bg-secondary/40 p-3">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-2xs text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {e.userId
                      ? (userNames.get(e.userId) ??
                        t('complaintReport.unknownUser', { defaultValue: 'Unknown user' }))
                      : t('complaintReport.systemUser', { defaultValue: 'System' })}
                  </span>
                  <span>
                    {e.action === 'create'
                      ? t('complaintReport.historyCreated', {
                          defaultValue: 'created the complaint',
                        })
                      : t('complaintReport.historyEdited', { defaultValue: 'edited' })}
                  </span>
                  {e.timestamp && (
                    <span className="tabular-nums">{new Date(e.timestamp).toLocaleString()}</span>
                  )}
                </div>
                {e.action === 'update' && (
                  <ul className="space-y-1">
                    {e.changes.map((c) => (
                      <li key={c.field} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                        <span className="font-medium capitalize text-foreground">
                          {c.field.replaceAll('_', ' ')}
                        </span>
                        <span className="min-w-0 break-words text-muted-foreground">
                          <span className={cn(c.from === '—' && 'opacity-60')}>{c.from}</span>
                          <span aria-hidden className="mx-1.5">
                            →
                          </span>
                          <span className="text-foreground">{c.to}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Drawer>
  );
}
