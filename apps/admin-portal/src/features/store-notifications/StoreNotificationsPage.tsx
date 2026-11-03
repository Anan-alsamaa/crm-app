import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill, Skeleton, cn, toast } from '@yiji/ui';
import { PAGE_BODY, PageHeader } from '../../components/shell/Page.js';
import { branchNotifies, normalizeOrderId } from '@yiji/shared-types';
import { optionsWith, useOptionLists } from '../../lib/option-lists.js';
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
 * THE ADMINISTRATOR'S PAGE (owner, 2026-11-03): only the Administrator sees
 * it, and what it says decides for every ticket however it was raised -
 * Create ticket, a chat, Late orders, the Yiji API. A type the Administrator
 * has not set follows the default: every type notifies except Driver attitude,
 * Late driver, Technical issue and Other (see `branchNotifies`). Each button
 * shows what a new ticket of that type does TODAY, default or not.
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
            'bg-ink text-ink-foreground'
          : // Filled, not outlined: on a bare card a hairline ring alone is
            // invisible, and these stop reading as controls at all.
            'bg-secondary text-foreground/80 hover:text-foreground',
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
        {normalizeOrderId(row.order_id) ? <span className="font-mono">#{row.order_id}</span> : none}
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
  const lists = useOptionLists();
  /* The ticket types agents can actually pick, live from Dropdown values. */
  const types = useMemo(() => optionsWith(lists.data, 'complaint_type'), [lists.data]);

  const byType = useMemo(() => {
    const m = new Map<string, { id: string; enabled: boolean }>();
    for (const r of rules.data ?? []) m.set(r.complaint_type, { id: r.id, enabled: r.enabled });
    return m;
  }, [rules.data]);

  const notifies = (type: string) => branchNotifies(type, rules.data ?? []);
  const enabledCount = types.filter(notifies).length;

  const toggle = (type: string) => {
    const current = byType.get(type);
    setRule.mutate(
      { complaintType: type, enabled: !notifies(type), existingId: current?.id },
      {
        onError: () =>
          toast.error(t('storeNotify.saveError', { defaultValue: 'Could not save that change' })),
      },
    );
  };

  return (
    /* The Rapport page frame (owner, 2026-10-22): this page had no title at
       all and sat in a centred 6xl column. It now opens like every other page
       and runs the header's full width. */
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title={t('nav.storeNotifications', { defaultValue: 'Branch notifications' })} />
      <div className={cn(PAGE_BODY, 'space-y-4')}>
        {/* A plain frosted section - no hue bar beside the title (side stripes
          are banned in this skin). */}
        <section className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                {t('storeNotify.rulesTitle', { defaultValue: 'Tickets the branch is told about' })}
              </h2>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                {t('storeNotify.rulesHelp', {
                  defaultValue:
                    'A new ticket is reported to its branch when its ticket type is selected here - from Create ticket, a chat, Late orders or the Yiji API. The branch receives the order number, the description and the resolution notes - nothing else about the customer.',
                })}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t('storeNotify.enabledCount', {
                defaultValue: '{{n}} of {{total}} selected',
                n: enabledCount,
                total: types.length,
              })}
            </span>
          </header>
          <div className="mt-4">
            {rules.isLoading || lists.isLoading ? (
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-32 rounded-full" />
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {types.map((type) => (
                  <TypeToggle
                    key={type}
                    type={type}
                    enabled={notifies(type)}
                    busy={setRule.isPending}
                    onToggle={() => toggle(type)}
                  />
                ))}
              </div>
            )}
            {enabledCount === 0 && !rules.isLoading && !lists.isLoading && (
              // A proper notice card, not a bare paragraph — warning-foreground ink
              // because the raw warning hue is a light token that fails on light.
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-warning-tint px-3.5 py-2.5 text-xs leading-relaxed text-warning ring-1 ring-warning/25">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
                <span>
                  {t('storeNotify.noneSelected', {
                    defaultValue:
                      'Nothing is selected, so no branch is told about anything. Pick the ticket types a branch can act on.',
                  })}
                </span>
              </p>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-foreground/[0.06] px-5 py-4">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {t('storeNotify.queueTitle', { defaultValue: 'What has been queued' })}
            </h2>
            <span className="ms-auto text-xs text-muted-foreground">
              {/* Said plainly rather than implied by a row of "queued" pills that
                an admin could read as "delivered". */}
              {t('storeNotify.pendingTransport', {
                defaultValue: "Sent to each branch's SaraPOS",
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
                  <tr className="text-xs text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.07)]">
                    <th className="h-11 px-4 text-start font-semibold first:ps-5 last:pe-5">
                      {t('storeNotify.branch', { defaultValue: 'Branch' })}
                    </th>
                    <th className="h-11 px-4 text-start font-semibold first:ps-5 last:pe-5">
                      {t('storeNotify.type', { defaultValue: 'Ticket type' })}
                    </th>
                    <th className="h-11 px-4 text-start font-semibold first:ps-5 last:pe-5">
                      {t('storeNotify.sends', { defaultValue: 'What the branch gets' })}
                    </th>
                    <th className="h-11 px-4 text-end font-semibold first:ps-5 last:pe-5">
                      {t('storeNotify.status', { defaultValue: 'Status' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(queue.data ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-foreground/[0.06] align-top">
                      <td className="px-4 py-3.5 ps-5 font-medium text-foreground">
                        {[row.store?.code, row.store?.name].filter(Boolean).join(' ') || '—'}
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {row.complaint_type ?? '—'}
                      </td>
                      <td className="max-w-[32rem] px-4 py-3.5">
                        <Preview row={row} />
                      </td>
                      <td className="px-4 py-3.5 pe-5 text-end">
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
    </div>
  );
}
