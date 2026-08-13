import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readRevisions, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { Skeleton, cn } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Field-level change history — who changed what, from which value to which.
 *
 * Built on Directus's OWN audit trail (activity + revisions), not a custom
 * diff log. That choice is the accuracy guarantee: every write path lands in
 * revisions with the actor attached — the portal, a CSV import, a raw API
 * call — where a client-side diff would only ever see the portal's own edits.
 * A revision's `delta` holds the new values; the OLD value for a field is
 * whatever the previous revision's `data` snapshot said. Deletion leaves the
 * activity row (and these revisions) behind, so "who deleted it" survives the
 * ticket itself.
 */

/** Bookkeeping columns that would drown the real changes. */
const NOISE = new Set([
  'date_updated',
  'user_updated',
  'date_created',
  'user_created',
  'id',
  'sort',
]);

interface RevisionRow {
  id: number;
  data: Record<string, unknown> | null;
  delta: Record<string, unknown> | null;
  activity: { id: number; action: string; timestamp: string; user: string | null } | null;
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}
export interface HistoryEntry {
  id: number;
  action: string;
  timestamp: string;
  userId: string | null;
  changes: FieldChange[];
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // A paragraph-long description still reads; a wall of it does not.
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

/** Revisions (oldest first) → one entry per edit, with old→new per field. */
export function revisionsToEntries(revisions: RevisionRow[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let prevData: Record<string, unknown> | null = null;
  for (const rev of revisions) {
    const action = rev.activity?.action ?? 'update';
    const changes: FieldChange[] = [];
    if (action === 'update') {
      for (const [field, next] of Object.entries(rev.delta ?? {})) {
        if (NOISE.has(field)) continue;
        const before = prevData?.[field];
        // A "change" to the identical value is write noise, not history.
        if (show(before) === show(next)) continue;
        changes.push({ field, from: show(before), to: show(next) });
      }
      if (changes.length === 0) {
        prevData = rev.data ?? prevData;
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
    prevData = rev.data ?? prevData;
  }
  return entries.reverse(); // newest first for display
}

function useTicketRevisions(ticketId: string) {
  return useQuery({
    queryKey: ['ticket-revisions', ticketId],
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
}

function useUserNames() {
  return useQuery({
    queryKey: ['user-names'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readUsers({ limit: -1, fields: ['id', 'first_name', 'last_name', 'email'] }),
      )) as unknown as Array<{ id: string; first_name: string | null; email: string | null }>;
      return new Map(rows.map((u) => [u.id, u.first_name ?? u.email ?? u.id]));
    },
  });
}

export function ChangeHistory({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation();
  const revisions = useTicketRevisions(ticketId);
  const names = useUserNames();

  const entries = useMemo(() => revisionsToEntries(revisions.data ?? []), [revisions.data]);

  const fieldLabel = (field: string) =>
    t(`complaint.field.${field}`, {
      // snake_case → words as the honest default; the important fields get
      // proper labels in the locale files.
      defaultValue: field.replaceAll('_', ' '),
    });

  if (revisions.isLoading) return <Skeleton className="h-20 w-full rounded-xl" />;
  if (entries.length === 0)
    return (
      <p className="text-2xs text-muted-foreground">
        {t('tickets.noFieldChanges', {
          defaultValue: 'No field changes recorded since this ticket was created.',
        })}
      </p>
    );

  return (
    <ol className="space-y-3">
      {entries.map((e) => (
        <li key={e.id} className="rounded-xl bg-secondary/40 p-3">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-2xs text-muted-foreground">
            <span className="font-semibold text-foreground">
              {e.userId
                ? (names.data?.get(e.userId) ??
                  t('tickets.unknownUser', { defaultValue: 'Unknown user' }))
                : t('tickets.systemUser', { defaultValue: 'System' })}
            </span>
            <span>
              {e.action === 'create'
                ? t('tickets.historyCreated', { defaultValue: 'created the ticket' })
                : t('tickets.historyEdited', { defaultValue: 'edited' })}
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
                    {fieldLabel(c.field)}
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
  );
}
