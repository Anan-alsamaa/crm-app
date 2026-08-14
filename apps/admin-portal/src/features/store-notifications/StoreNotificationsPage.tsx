import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill, SectionCard, Skeleton, cn, toast } from '@yiji/ui';
import { ComplaintType } from '@yiji/shared-types';
import {
  useSetStoreNotifyRule,
  useStoreNotifications,
  useStoreNotifyRules,
  type StoreNotificationRow,
} from './api.js';

/**
 * Which complaints reach the branch, and what has been queued for them.
 *
 * The rule is deliberately ONE dimension — the complaint type — because that is
 * the field that says whether the branch is where it happened. A technical
 * issue with the app or a driver's attitude is nothing a branch manager can act
 * on, and a queue that forwards everything is a queue nobody reads.
 *
 * Nothing is enabled by default. An empty configuration means "not set up yet",
 * and the safe reading of that is to tell nobody: a missing notification is
 * recoverable, one that has already gone out to 132 branches is not.
 */
const STATUS_TONE = {
  queued: 'neutral',
  sent: 'success',
  failed: 'destructive',
} as const;

function TypeToggle({
  type,
  enabled,
  onToggle,
  busy,
}: {
  type: string;
  enabled: boolean;
  onToggle: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={enabled}
      className={cn(
        'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-out disabled:opacity-60',
        enabled
          ? // Selected reads as a jade wash — the board's tinted-pill idiom —
            // with an inset ring so the edge holds on both themes.
            'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
          : // Filled, not outlined: on a bare card a hairline ring alone is
            // invisible, and these stop reading as controls at all.
            'bg-secondary/60 text-muted-foreground hover:text-foreground',
      )}
    >
      {type}
    </button>
  );
}

function Preview({ row }: { row: StoreNotificationRow }) {
  const { t } = useTranslation();
  const none = (
    <span className="text-muted-foreground/60">
      {t('storeNotify.notWritten', { defaultValue: 'not written' })}
    </span>
  );
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      {/* The order leads: a branch reads "which order" before it reads
          "what went wrong", because the first is what they look up. */}
      <p>
        <span className="text-muted-foreground">
          {t('storeNotify.order', { defaultValue: 'Order' })}:{' '}
        </span>
        {row.order_id ? <span className="font-mono">#{row.order_id}</span> : none}
      </p>
      {row.order_items && row.order_items.length > 0 && (
        <p className="line-clamp-2 text-muted-foreground">
          {row.order_items.map((i) => `${i.qty}× ${i.name}`).join(', ')}
        </p>
      )}
      <p className="line-clamp-2">
        <span className="text-muted-foreground">
          {t('storeNotify.description', { defaultValue: 'Description' })}:{' '}
        </span>
        {row.description ?? none}
      </p>
      <p className="line-clamp-2">
        <span className="text-muted-foreground">
          {t('storeNotify.resolution', { defaultValue: 'Resolution notes' })}:{' '}
        </span>
        {row.resolution_notes ?? none}
      </p>
    </div>
  );
}

export function StoreNotificationsPage() {
  const { t } = useTranslation();
  const rules = useStoreNotifyRules();
  const setRule = useSetStoreNotifyRule();
  const queue = useStoreNotifications();

  const byType = useMemo(() => {
    const m = new Map<string, { id: string; enabled: boolean }>();
    for (const r of rules.data ?? []) m.set(r.complaint_type, { id: r.id, enabled: r.enabled });
    return m;
  }, [rules.data]);

  const enabledCount = useMemo(
    () => ComplaintType.options.filter((o) => byType.get(o)?.enabled).length,
    [byType],
  );

  const toggle = (type: string) => {
    const current = byType.get(type);
    setRule.mutate(
      { complaintType: type, enabled: !current?.enabled, existingId: current?.id },
      {
        onError: () =>
          toast.error(t('storeNotify.saveError', { defaultValue: 'Could not save that change' })),
      },
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <SectionCard
        title={t('storeNotify.rulesTitle', { defaultValue: 'Complaints the branch is told about' })}
        hint={t('storeNotify.rulesHelp', {
          defaultValue:
            'A ticket is reported to its branch only when its complaint type is selected here. The branch receives the order number and its items, the description and the resolution notes — nothing else about the customer.',
        })}
        aside={
          <span className="tabular-nums">
            {t('storeNotify.enabledCount', {
              defaultValue: '{{n}} of {{total}} selected',
              n: enabledCount,
              total: ComplaintType.options.length,
            })}
          </span>
        }
      >
        {rules.isLoading ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-32 rounded-full" />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ComplaintType.options.map((type) => (
              <TypeToggle
                key={type}
                type={type}
                enabled={!!byType.get(type)?.enabled}
                busy={setRule.isPending}
                onToggle={() => toggle(type)}
              />
            ))}
          </div>
        )}
        {enabledCount === 0 && !rules.isLoading && (
          // A proper notice card, not a bare paragraph — warning-foreground ink
          // because the raw warning hue is a light token that fails on light.
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-warning/15 px-3.5 py-2.5 text-xs leading-relaxed text-warning-foreground ring-1 ring-warning/25">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
            <span>
              {t('storeNotify.noneSelected', {
                defaultValue:
                  'Nothing is selected, so no branch is told about anything. Pick the complaint types a branch can act on.',
              })}
            </span>
          </p>
        )}
      </SectionCard>

      <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        <header className="flex items-baseline gap-2 border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('storeNotify.queueTitle', { defaultValue: 'What has been queued' })}
          </h2>
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
            {/* Said plainly rather than implied by a row of "queued" pills that
                an admin could read as "delivered". */}
            {t('storeNotify.pendingTransport', {
              defaultValue: 'Delivery to the stores is not connected yet',
            })}
          </span>
        </header>
        {queue.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        ) : (queue.data ?? []).length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t('storeNotify.queueEmpty', {
              defaultValue: 'Nothing queued yet.',
            })}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="px-4 py-2.5 text-start font-semibold">
                    {t('storeNotify.branch', { defaultValue: 'Branch' })}
                  </th>
                  <th className="px-4 py-2.5 text-start font-semibold">
                    {t('storeNotify.type', { defaultValue: 'Complaint type' })}
                  </th>
                  <th className="px-4 py-2.5 text-start font-semibold">
                    {t('storeNotify.sends', { defaultValue: 'What the branch gets' })}
                  </th>
                  <th className="px-4 py-2.5 text-end font-semibold">
                    {t('storeNotify.status', { defaultValue: 'Status' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(queue.data ?? []).map((row) => (
                  <tr key={row.id} className="border-t border-border/60 align-top">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {[row.store?.code, row.store?.name].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.complaint_type ?? '—'}</td>
                    <td className="max-w-[32rem] px-4 py-3">
                      <Preview row={row} />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Pill tone={STATUS_TONE[row.status] ?? 'neutral'} size="sm">
                        {row.status}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
