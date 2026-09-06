/**
 * Choosing a spreadsheet, seeing what it would do, then doing it.
 *
 * The preview is the point. A sheet is 1,600 rows more often than 5, and every
 * mistake in it lands as a ticket somebody then has to find and delete one at a
 * time — so this reads the file, resolves every row against the store master,
 * the contacts and the agents, and reports what WOULD happen before anything is
 * written. Confirm is the only thing that writes.
 */
import { useState } from 'react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { createItems, readItems, readUsers } from '@directus/sdk';
import { ConfirmDialog, toast } from '@yiji/ui';
import type { StoreIndex } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import {
  parseTicketFile,
  planImport,
  runImport,
  ticketIdentity,
  type ImportPlan,
} from './import-tickets.js';

interface Props {
  storeIndex: StoreIndex;
  /** Called after a successful import so the report refetches. */
  onImported: () => void;
  label: string;
}

interface Loaded {
  fileName: string;
  plan: ImportPlan;
  contactByPhone: Map<string, string>;
}

export function ImportTicketsButton({ storeIndex, onImported, label }: Props): JSX.Element {
  const { t } = useTranslation(['reports', 'common']);
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  /**
   * Everything the plan needs to resolve a row, read once per import.
   *
   * `limit: -1` on tickets sounds heavy and is the only honest option: a row's
   * identity has to be compared against every ticket already stored, or a
   * re-import silently doubles the ones it cannot see.
   */
  async function loadContext() {
    const [tickets, contacts, users, vendors] = await Promise.all([
      directus.request(
        readItems(
          'tickets' as never,
          {
            limit: -1,
            fields: ['complaint_date', 'order_id', 'description'],
          } as never,
        ),
      ) as unknown as Promise<
        Array<{
          complaint_date: string | null;
          order_id: string | null;
          description: string | null;
        }>
      >,
      directus.request(
        readItems('contacts' as never, { limit: -1, fields: ['id', 'phone'] } as never),
      ) as unknown as Promise<Array<{ id: string; phone: string | null }>>,
      directus.request(
        readUsers({ limit: -1, fields: ['id', 'first_name'] }),
      ) as unknown as Promise<Array<{ id: string; first_name: string | null }>>,
      directus.request(
        readItems('vendors' as never, { limit: 1, fields: ['id'] } as never),
      ) as unknown as Promise<Array<{ id: string }>>,
    ]);

    const existing = new Set(
      tickets.map((x) =>
        ticketIdentity(x.complaint_date, String(x.order_id ?? ''), String(x.description ?? '')),
      ),
    );
    const contactByPhone = new Map<string, string>();
    for (const c of contacts) if (c.phone) contactByPhone.set(String(c.phone), c.id);
    const agentByName = new Map<string, string>();
    for (const u of users) {
      const n = (u.first_name ?? '').trim().toLowerCase();
      if (n && !agentByName.has(n)) agentByName.set(n, u.id);
    }
    return { existing, contactByPhone, agentByName, vendorId: vendors[0]?.id ?? null };
  }

  async function onFile(file: File) {
    setReading(true);
    try {
      const parsed = await parseTicketFile(file);
      const ctx = await loadContext();
      const plan = planImport(parsed.rows, { index: storeIndex, ...ctx });
      // The parser's own findings belong in the preview too — an unplaceable
      // header is usually a typo, and silently ignoring it loses a column.
      plan.unmappedHeaders = parsed.unmappedHeaders;
      plan.skipped = [...parsed.skipped, ...plan.skipped];
      setLoaded({ fileName: file.name, plan, contactByPhone: ctx.contactByPhone });
    } catch (err) {
      toast.error(
        t('complaintReport.importUnreadable', {
          defaultValue: 'Could not read that file: {{why}}',
          why: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setReading(false);
    }
  }

  async function confirm() {
    if (!loaded) return;
    setRunning(true);
    try {
      const res = await runImport(
        loaded.plan,
        {
          createContacts: async (phones) => {
            const made = (await directus.request(
              createItems('contacts' as never, phones.map((phone) => ({ phone })) as never),
            )) as unknown as Array<{ id: string; phone: string }>;
            return new Map(made.map((c) => [String(c.phone), c.id]));
          },
          createTickets: async (payloads) => {
            await directus.request(createItems('tickets' as never, payloads as never));
          },
        },
        loaded.contactByPhone,
      );

      if (res.failed > 0) {
        toast.error(
          t('complaintReport.importPartial', {
            defaultValue: 'Imported {{created}}; {{failed}} rows were refused.',
            created: res.created,
            failed: res.failed,
          }),
        );
      } else {
        toast.success(
          t('complaintReport.importDone', {
            defaultValue: 'Imported {{created}} tickets.',
            created: res.created,
          }),
        );
      }
      setLoaded(null);
      onImported();
    } catch (err) {
      toast.error(
        t('complaintReport.importFailed', {
          defaultValue: 'The import failed: {{why}}',
          why: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setRunning(false);
    }
  }

  const p = loaded?.plan;

  return (
    <>
      {/* A label styled as a button, because a bare file input cannot be, and
          hiding the input behind a ref would take a click handler to do the
          same job the label already does natively. */}
      <label>
        <input
          type="file"
          accept=".csv,.xlsx"
          className="sr-only"
          disabled={reading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first: choosing the SAME file twice fires no change event
            // otherwise, so a corrected re-import would appear to do nothing.
            e.target.value = '';
            if (file) void onFile(file);
          }}
        />
        <span
          className="ring-1 ring-border inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-sm font-medium hover:bg-muted"
          role="button"
          tabIndex={0}
        >
          {reading ? t('complaintReport.importReading', { defaultValue: 'Reading…' }) : label}
        </span>
      </label>

      <ConfirmDialog
        open={!!loaded}
        loading={running}
        onCancel={() => setLoaded(null)}
        onConfirm={() => void confirm()}
        title={t('complaintReport.importTitle', {
          defaultValue: 'Import {{count}} tickets?',
          count: p?.create.length ?? 0,
        })}
        description={
          p ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">{loaded?.fileName}</p>
              <ul className="space-y-1">
                <li>
                  <strong>{p.create.length}</strong>{' '}
                  {t('complaintReport.importNew', { defaultValue: 'new tickets' })}
                </li>
                <li>
                  <strong>{p.newContacts}</strong>{' '}
                  {t('complaintReport.importContacts', { defaultValue: 'new customers' })}
                </li>
                {p.duplicates > 0 && (
                  <li className="text-muted-foreground">
                    <strong>{p.duplicates}</strong>{' '}
                    {t('complaintReport.importDupes', {
                      defaultValue: 'already loaded — skipped',
                    })}
                  </li>
                )}
                {p.unmatchedStores > 0 && (
                  <li className="text-muted-foreground">
                    <strong>{p.unmatchedStores}</strong>{' '}
                    {t('complaintReport.importUnmatched', {
                      defaultValue:
                        'with a branch not in the store list — they import as “Not mapped”',
                    })}
                  </li>
                )}
                {p.skipped.length > 0 && (
                  <li className="text-destructive">
                    <strong>{p.skipped.length}</strong>{' '}
                    {t('complaintReport.importSkipped', {
                      defaultValue: 'rows cannot be imported',
                    })}{' '}
                    {/* Naming the first few makes the sheet fixable; a bare
                        count only says something is wrong somewhere. */}
                    <span className="text-muted-foreground">
                      (
                      {p.skipped
                        .slice(0, 3)
                        .map((s) => `line ${s.line}: ${s.reason}`)
                        .join('; ')}
                      {p.skipped.length > 3 ? '…' : ''})
                    </span>
                  </li>
                )}
                {p.unmappedHeaders.length > 0 && (
                  <li className="text-destructive">
                    {t('complaintReport.importUnknownCols', {
                      defaultValue: 'Columns not recognised: {{cols}}',
                      cols: p.unmappedHeaders.join(', '),
                    })}
                  </li>
                )}
              </ul>
            </div>
          ) : null
        }
        confirmLabel={t('complaintReport.importConfirm', { defaultValue: 'Import' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
      />
    </>
  );
}
