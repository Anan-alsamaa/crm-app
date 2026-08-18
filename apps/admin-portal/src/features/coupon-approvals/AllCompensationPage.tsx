import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  Input,
  Pill,
  SelectMenu,
  Skeleton,
  Table,
  TableSurface,
  Td,
  Th,
  Toolbar,
  ToolbarSpacer,
  Tr,
  formatRelative,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Every coupon anyone has asked for, in whatever state it reached.
 *
 * Distinct from Coupon approvals on purpose: that page is a queue of decisions
 * still to make, and a supervisor working it should not have to read past a
 * hundred settled rows to find the two waiting on them. This is the record —
 * what was granted, to whom, by whom, and what happened to it.
 */
interface Row {
  id: string;
  title: string | null;
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  status: string | null;
  edited_by_admin: boolean | null;
  date_created: string | null;
  valid_from: string | null;
  valid_to: string | null;
  requested_by: { id: string; first_name: string | null; email: string | null } | null;
  contact: { name: string | null; phone: string | null } | null;
}

function useAllCoupons() {
  return useQuery({
    queryKey: ['all-compensation'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            limit: -1,
            sort: ['-date_created'],
            fields: [
              'id',
              'title',
              'coupon_code',
              'coupon_value',
              'coupon_percent',
              'status',
              'edited_by_admin',
              'date_created',
              'valid_from',
              'valid_to',
              { requested_by: ['id', 'first_name', 'email'] },
              { contact: ['name', 'phone'] },
            ],
          } as never,
        ),
      )) as unknown as Row[],
  });
}

const TONE: Record<string, 'success' | 'destructive' | 'warning' | 'neutral'> = {
  approved: 'success',
  rejected: 'destructive',
  pending: 'warning',
};

export function AllCompensationPage() {
  const { t } = useTranslation();
  const rows = useAllCoupons();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [agent, setAgent] = useState('');

  const list = rows.data ?? [];

  /** Who has ever raised one — the filter offers only names that appear. */
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of list) {
      if (!r.requested_by?.id) continue;
      // `||` not `??`: an unset first name is an empty string.
      m.set(r.requested_by.id, r.requested_by.first_name?.trim() || r.requested_by.email || '—');
    }
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [list]);

  const filtered = useMemo(
    () =>
      list.filter((r) => {
        const day = (r.date_created ?? '').slice(0, 10);
        if (from && day < from) return false;
        // Inclusive of the end day: an admin asking for "up to the 17th" means
        // including the 17th, not up to midnight at its start.
        if (to && day > to) return false;
        if (agent && r.requested_by?.id !== agent) return false;
        return true;
      }),
    [list, from, to, agent],
  );

  const worth = (r: Row) =>
    r.coupon_percent != null
      ? `${r.coupon_percent}%`
      : r.coupon_value != null
        ? `${r.coupon_value}`
        : '—';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('compensationAll.title', { defaultValue: 'Compensation' })}
        </h1>
        <ToolbarSpacer />
        <span className="text-2xs tabular-nums text-muted-foreground">
          {t('compensationAll.count', {
            defaultValue: '{{n}} of {{total}}',
            n: filtered.length,
            total: list.length,
          })}
        </span>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-6xl space-y-5">
          <div className="border-b border-foreground/10 pb-5">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('compensationAll.hint', {
                defaultValue:
                  'Every coupon anyone has asked for, whatever state it reached. Coupon approvals is the queue of decisions still to make; this is the record.',
              })}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,14rem)]">
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('performance.from', { defaultValue: 'From' })}
              </span>
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label={t('performance.from', { defaultValue: 'From' })}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('performance.to', { defaultValue: 'To' })}
              </span>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label={t('performance.to', { defaultValue: 'To' })}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('compensationAll.agent', { defaultValue: 'Assigned by' })}
              </span>
              <SelectMenu
                fullWidth
                value={agent}
                onChange={setAgent}
                aria-label={t('compensationAll.agent', { defaultValue: 'Assigned by' })}
                options={[
                  { value: '', label: t('compensationAll.anyAgent', { defaultValue: 'Anyone' }) },
                  ...agents,
                ]}
              />
            </label>
          </div>

          {rows.isLoading ? (
            <Skeleton className="h-64 w-full rounded-2xl" />
          ) : (
            <TableSurface>
              <Table>
                <thead>
                  <Tr>
                    <Th>{t('coupons.code', { defaultValue: 'Coupon code' })}</Th>
                    <Th>{t('compensationAll.customer', { defaultValue: 'Customer' })}</Th>
                    <Th>{t('compensationAll.agent', { defaultValue: 'Assigned by' })}</Th>
                    <Th className="text-end">
                      {t('compensationAll.worth', { defaultValue: 'Worth' })}
                    </Th>
                    <Th>{t('compensationAll.state', { defaultValue: 'State' })}</Th>
                    <Th className="text-end">
                      {t('compensationAll.raised', { defaultValue: 'Raised' })}
                    </Th>
                  </Tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <Tr>
                      <Td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                        {list.length === 0
                          ? t('compensationAll.none', {
                              defaultValue: 'No coupon has been raised yet.',
                            })
                          : t('compensationAll.noMatches', {
                              defaultValue: 'No coupon matches those filters.',
                            })}
                      </Td>
                    </Tr>
                  ) : (
                    filtered.map((r) => (
                      <Tr key={r.id}>
                        <Td className="font-mono text-xs font-semibold text-foreground">
                          {r.coupon_code ?? '—'}
                        </Td>
                        <Td>
                          <span className="block text-sm text-foreground">
                            {r.contact?.name || r.title || '—'}
                          </span>
                          <span className="block text-2xs text-muted-foreground">
                            {r.contact?.phone ?? ''}
                          </span>
                        </Td>
                        <Td className="text-sm">
                          {r.requested_by?.first_name?.trim() || r.requested_by?.email || '—'}
                        </Td>
                        <Td className="text-end tabular-nums font-semibold">{worth(r)}</Td>
                        <Td>
                          <Pill
                            tone={TONE[(r.status ?? 'pending').toLowerCase()] ?? 'neutral'}
                            size="sm"
                          >
                            {t(`status.${r.status ?? 'pending'}`, {
                              ns: 'common',
                              defaultValue: r.status ?? 'pending',
                            })}
                          </Pill>
                          {r.edited_by_admin && (
                            <span className="ms-1.5 text-2xs text-muted-foreground">
                              {t('compensationAll.amended', { defaultValue: 'amended' })}
                            </span>
                          )}
                        </Td>
                        <Td className="text-end text-2xs tabular-nums text-muted-foreground">
                          {formatRelative(r.date_created)}
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            </TableSurface>
          )}
        </div>
      </div>
    </div>
  );
}
