import { useState } from 'react';
import { readItems } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { Button, DownloadIcon, Toolbar, cn, toast } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Self-serve backup: every business collection, one JSON file, downloaded to
 * the admin's machine.
 *
 * The ops portal's answer was "copy complaints.db"; ours is Postgres, so the
 * equivalent artefact is a portable export. The file carries a manifest
 * (version, when, row counts) so a restore can sanity-check before writing —
 * restore itself is deliberately a SCRIPT (`scripts/restore-backup.mjs`, run
 * by an operator with admin credentials), not a button: a browser upload that
 * overwrites the database is one mis-click from being the incident it exists
 * to recover from.
 *
 * What this is NOT: a substitute for `pg_dump` on the host, which also carries
 * the Directus system tables (users, roles, permissions). This is the
 * business-data layer — the thing an operator actually reaches for when a
 * ticket was mangled or a list was emptied by mistake.
 */
const COLLECTIONS = [
  'vendors',
  'teams',
  'brands',
  'stores',
  'contacts',
  'conversations',
  'messages',
  'tickets',
  'ticket_events',
  'tags',
  'conversations_tags',
  'contacts_tags',
  'tickets_tags',
  'coupon_approvals',
  'store_notifications',
  'store_notify_rules',
  'quick_replies',
  'option_lists',
  'app_settings',
  'app_roles',
  'routing_events',
  'csat_responses',
  'sla_policies',
  'reports',
  'custom_fields',
  'custom_field_values',
  'automation_rules',
  'notifications',
] as const;

const BACKUP_VERSION = 1;

export function BackupPage() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, number | 'error'>>({});

  const run = async () => {
    setRunning(true);
    setProgress({});
    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    /**
     * Tracked locally, NOT read back from React state: `progress` in this
     * closure is the render-time snapshot, so a manifest built from it would
     * have listed zero failures no matter what failed — a backup that lies
     * about its own gaps is worse than one with gaps.
     */
    const failedCollections: string[] = [];
    for (const collection of COLLECTIONS) {
      try {
        const rows = (await directus.request(
          readItems(collection as never, { limit: -1 } as never),
        )) as unknown as unknown[];
        data[collection] = rows;
        counts[collection] = rows.length;
        setProgress((p) => ({ ...p, [collection]: rows.length }));
      } catch {
        // Say which collection failed instead of aborting the lot — a backup
        // missing one collection and SAYING so beats no backup.
        failedCollections.push(collection);
        setProgress((p) => ({ ...p, [collection]: 'error' }));
      }
    }
    const payload = {
      manifest: {
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        counts,
        failedCollections,
      },
      data,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yiji-crm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setRunning(false);
    if (failedCollections.length > 0) {
      toast.error(
        t('backup.partial', {
          n: failedCollections.length,
          defaultValue: 'Backup saved, but {{n}} collection(s) could not be read — see the list.',
        }),
      );
    } else {
      toast.success(t('backup.done', { defaultValue: 'Backup downloaded.' }));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('backup.title', { defaultValue: 'Backup' })}
        </h1>
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-2xl space-y-4">
          {/* The action card — tinted icon chip at the start, per the board
              language for operations a page offers. */}
          <div className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
            <div className="flex items-start gap-3.5">
              <span
                aria-hidden
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary"
              >
                <DownloadIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  {t('backup.exportTitle', { defaultValue: 'Download a full backup' })}
                </h2>
                <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  {t('backup.exportHelp', {
                    defaultValue:
                      'Every business collection — tickets, chats, contacts, lists, settings — as one JSON file on your machine. Restoring is an operator action: hand the file to whoever runs the system, with scripts/restore-backup.mjs.',
                  })}
                </p>
                <div className="mt-4">
                  <Button onClick={run} disabled={running}>
                    {running
                      ? t('backup.running', { defaultValue: 'Exporting…' })
                      : t('backup.run', { defaultValue: 'Download backup' })}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {Object.keys(progress).length > 0 && (
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-2xl bg-card p-5 text-xs shadow-soft ring-1 ring-foreground/[0.06] sm:grid-cols-3">
              {COLLECTIONS.filter((c) => c in progress).map((c) => (
                <li key={c} className="flex items-baseline justify-between gap-2">
                  {/* Collection ids are code, so they read in mono. */}
                  <span className="truncate font-mono text-2xs text-muted-foreground">{c}</span>
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      progress[c] === 'error' ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {progress[c] === 'error'
                      ? t('backup.failed', { defaultValue: 'failed' })
                      : progress[c]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
