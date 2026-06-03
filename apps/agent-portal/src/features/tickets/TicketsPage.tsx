import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  formatRelative,
  Pill,
  Select,
  Skeleton,
  Spinner,
  TicketEmptyArt,
  Toolbar,
} from '@yiji/ui';
import type { Priority, TicketStatus } from '@yiji/shared-types';
import { useTickets, useTicket, useTicketEvents, useUpdateTicket } from './api.js';

const STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

type TicketFilter = 'all' | TicketStatus | 'overdue';
const FILTERS: TicketFilter[] = ['all', 'new', 'open', 'pending', 'resolved', 'overdue'];

const STATUS_TONE: Record<TicketStatus, 'primary' | 'success' | 'warning' | 'muted' | 'neutral'> = {
  new: 'primary',
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};

function StatusPill({ status }: { status: TicketStatus }) {
  const { t } = useTranslation();
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`, { ns: 'common' })}
    </Pill>
  );
}

export function TicketsPage() {
  const { t } = useTranslation();
  const tickets = useTickets();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<TicketFilter>('all');

  const isOverdue = (tk: { first_responded_at: string | null; first_response_due_at: string | null }) =>
    !tk.first_responded_at &&
    tk.first_response_due_at !== null &&
    new Date(tk.first_response_due_at).getTime() < Date.now();

  const list = tickets.data ?? [];
  const stats = useMemo(() => {
    const open = list.filter((t) => t.status === 'open' || t.status === 'new').length;
    const pending = list.filter((t) => t.status === 'pending').length;
    const overdue = list.filter(isOverdue).length;
    const today = list.filter((t) => {
      if (!t.date_created) return false;
      const d = new Date(t.date_created);
      const now = new Date();
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    }).length;
    return { open, pending, overdue, today };
  }, [list]);

  const filtered = useMemo(() => {
    if (filter === 'all') return list;
    if (filter === 'overdue') return list.filter(isOverdue);
    return list.filter((t) => t.status === filter);
  }, [list, filter]);

  const filterCount = (f: TicketFilter) => {
    if (f === 'all') return list.length;
    if (f === 'overdue') return stats.overdue;
    return list.filter((t) => t.status === f).length;
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Dense toolbar: title + inline filter tabs (also stand in as stats) */}
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('tickets.title')}
        </h1>
        <span className="opacity-30 text-xs text-muted-foreground">·</span>
        <div className="flex items-center gap-x-4 text-xs">
          {FILTERS.map((f) => {
            const active = filter === f;
            const count = filterCount(f);
            const tone =
              f === 'overdue'
                ? 'text-destructive'
                : f === 'pending'
                  ? 'text-warning-foreground'
                  : '';
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'group relative inline-flex items-center gap-1.5 h-12 transition-colors duration-fast ease-out focus-visible:outline-none',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="font-medium">
                  {f === 'all'
                    ? t('tickets.filterAll', { defaultValue: 'All' })
                    : f === 'overdue'
                      ? t('tickets.overdue', { defaultValue: 'Overdue' })
                      : t(`status.${f}`, { ns: 'common' })}
                </span>
                <span className={cn('tabular-nums text-2xs', !active && tone)}>
                  {count}
                </span>
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>
      </Toolbar>

      {/* Below: list + detail — no card wrapping */}
      <div className="flex flex-1 min-h-0">
      <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden">
        <div className="flex-1 overflow-auto pt-2">
          {tickets.isLoading ? (
            <ul className="px-2 space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={i}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5"
                >
                  <Skeleton className="h-7 w-7 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-3/4" />
                    <div className="flex items-center gap-1.5">
                      <Skeleton className="h-3.5 w-12 rounded-full" />
                      <Skeleton className="h-3.5 w-16 rounded-full" />
                    </div>
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </li>
              ))}
            </ul>
          ) : filtered.length > 0 ? (
            <ul className="space-y-2 px-3 py-2">
              {filtered.map((tk, i) => {
                const active = selected === tk.id;
                const overdue = isOverdue(tk);
                return (
                  <li
                    key={tk.id}
                    style={{ animationDelay: `${Math.min(i * 28, 280)}ms` }}
                    className="motion-safe:animate-fade-in"
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(tk.id)}
                      className={cn(
                        'group flex w-full items-start gap-3 rounded-2xl px-3.5 py-3 text-start',
                        'transition-[box-shadow,transform,background-color] duration-fast ease-out',
                        active
                          ? 'bg-card shadow-md shadow-foreground/[0.08] ring-1 ring-primary/30'
                          : 'bg-card/40 ring-1 ring-foreground/[0.03] hover:bg-card hover:shadow-sm hover:shadow-foreground/[0.06] hover:-translate-y-px',
                      )}
                    >
                      <Avatar name={tk.contact?.name} email={tk.contact?.email} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {tk.subject}
                          </span>
                          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                            {formatRelative(tk.date_created)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <StatusPill status={tk.status} />
                          {tk.priority !== 'medium' && tk.priority !== 'low' && (
                            <Pill tone={tk.priority === 'urgent' ? 'pink' : 'orange'} size="sm">
                              {t(`priority.${tk.priority}`, { ns: 'common' })}
                            </Pill>
                          )}
                          {overdue && (
                            <Pill tone="destructive" size="sm">
                              {t('tickets.overdue', { defaultValue: 'overdue' })}
                            </Pill>
                          )}
                        </div>
                        {tk.contact?.email && (
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {tk.contact.email}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-4 p-6 pt-12 text-center">
              <TicketEmptyArt size={160} />
              <div className="space-y-1">
                <h3 className="text-md font-semibold text-foreground">{t('tickets.empty')}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('tickets.emptyHint', {
                    defaultValue: 'Tickets are created from conversations that need follow-up.',
                  })}
                </p>
              </div>
            </div>
          )}
        </div>
      </aside>

      <section className="flex-1 overflow-auto bg-background">
        {selected ? (
          <TicketDetail ticketId={selected} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-md flex-col items-center gap-5">
              <TicketEmptyArt size={200} />
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-display tracking-tight">
                  {t('tickets.selectPrompt', { defaultValue: 'Open a ticket' })}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('tickets.selectHint', {
                    defaultValue:
                      'Pick a ticket on the left to see its workflow, SLA timeline, and history.',
                  })}
                </p>
              </div>
            </div>
          </div>
        )}
      </section>
      </div>
    </div>
  );
}

function TicketDetail({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation();
  const ticket = useTicket(ticketId);
  const events = useTicketEvents(ticketId);
  const update = useUpdateTicket();

  if (ticket.isLoading)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  if (!ticket.data) return null;
  const tk = ticket.data;

  const patch = (p: Parameters<typeof update.mutateAsync>[0]['patch']) =>
    void update.mutateAsync({ id: tk.id, patch: p });

  const dueClass = (iso: string | null) => {
    if (!iso) return 'text-muted-foreground';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'text-destructive font-medium';
    if (ms < 30 * 60_000) return 'text-warning font-medium';
    return 'text-foreground';
  };

  const statusTone: Record<TicketStatus, 'success' | 'warning' | 'muted' | 'primary' | 'neutral'> = {
    new: 'primary',
    open: 'success',
    pending: 'warning',
    resolved: 'primary',
    closed: 'muted',
  };

  return (
    <div className="mx-auto max-w-3xl space-y-7 p-6 sm:p-10">
      {/* Identity card — avatar + subject + contact + status pills */}
      <header className="space-y-4">
        <div className="flex items-start gap-4">
          <Avatar name={tk.contact?.name} email={tk.contact?.email} size="lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={statusTone[tk.status]} dot>
                {t(`status.${tk.status}`, { ns: 'common' })}
              </Pill>
              {tk.priority !== 'medium' && tk.priority !== 'low' && (
                <Pill tone={tk.priority === 'urgent' ? 'pink' : 'orange'}>
                  {t(`priority.${tk.priority}`, { ns: 'common' })}
                </Pill>
              )}
            </div>
            <h2 className="text-2xl font-bold text-display tracking-[-0.02em] text-balance">
              {tk.subject}
            </h2>
            <div className="text-xs text-muted-foreground">
              {tk.contact?.name ?? tk.contact?.email ?? t('inbox.unknownContact')}
              {tk.date_created && (
                <>
                  {' '}·{' '}
                  <span className="tabular-nums">
                    opened {new Date(tk.date_created).toLocaleDateString()}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {tk.description && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {tk.description}
          </p>
        )}
      </header>

      {/* Controls row — ghost selects, mark-responded CTA */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-4 py-3">
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('conversation.status')}</span>
          <Select
            value={tk.status}
            aria-label={t('conversation.status')}
            onChange={(e) => {
              const next = e.target.value as TicketStatus;
              const extra: Record<string, string> = {};
              if (next === 'resolved') extra.resolved_at = new Date().toISOString();
              if (next === 'closed') extra.closed_at = new Date().toISOString();
              patch({ status: next, ...extra });
            }}
            className="h-7 text-xs"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`, { ns: 'common' })}
              </option>
            ))}
          </Select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('conversation.priority')}</span>
          <Select
            value={tk.priority}
            aria-label={t('conversation.priority')}
            onChange={(e) => patch({ priority: e.target.value as Priority })}
            className="h-7 text-xs"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`priority.${p}`, { ns: 'common' })}
              </option>
            ))}
          </Select>
        </label>
        {!tk.first_responded_at && (
          <Button
            type="button"
            size="sm"
            className="ms-auto"
            onClick={() => patch({ first_responded_at: new Date().toISOString() })}
          >
            {t('tickets.markResponded')}
          </Button>
        )}
      </div>

      {/* SLA deadlines — borderless rows with status icons */}
      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('tickets.slaSection', { defaultValue: 'SLA' })}
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <SlaCard
            label={t('tickets.firstResponseDue')}
            iso={tk.first_response_due_at}
            metAt={tk.first_responded_at}
            dueClass={dueClass}
            metLabel={t('tickets.respondedAt')}
          />
          <SlaCard
            label={t('tickets.resolutionDue')}
            iso={tk.resolution_due_at}
            metAt={null}
            dueClass={dueClass}
          />
        </div>
      </section>

      {/* History timeline — actual timeline with connector line */}
      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t('tickets.history')}
        </h3>
        {events.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : events.data && events.data.length > 0 ? (
          <ol className="relative space-y-0">
            {/* Vertical connector */}
            <span
              aria-hidden
              className="absolute start-[7px] top-2 bottom-2 w-px bg-border"
            />
            {events.data.map((ev) => {
              const isWarn = ev.event_type === 'sla_warning';
              const isBreach = ev.event_type === 'sla_breached';
              const tone = isBreach ? 'destructive' : isWarn ? 'warning' : 'primary';
              const dotBg =
                tone === 'destructive'
                  ? 'bg-destructive'
                  : tone === 'warning'
                    ? 'bg-warning'
                    : 'bg-primary';
              return (
                <li key={ev.id} className="relative flex items-start gap-3 py-2.5 ps-0">
                  <span
                    className={cn(
                      'relative z-10 mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full ring-4 ring-background',
                      dotBg,
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {t(`tickets.event.${ev.event_type}`, { defaultValue: ev.event_type })}
                      </span>
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {ev.date_created ? new Date(ev.date_created).toLocaleString() : ''}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground/80">
            {t('tickets.noEvents')}
          </p>
        )}
      </section>
    </div>
  );
}

function SlaCard({
  label,
  iso,
  metAt,
  dueClass,
  metLabel,
}: {
  label: string;
  iso: string | null;
  metAt: string | null;
  dueClass: (iso: string | null) => string;
  metLabel?: string;
}) {
  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-4 py-4">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1.5 text-base font-semibold tabular-nums', dueClass(iso))}>
        {iso ? new Date(iso).toLocaleString() : '—'}
      </div>
      {metAt && (
        <div className="mt-2 inline-flex items-center gap-1.5 text-2xs font-medium text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          {metLabel} {new Date(metAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
