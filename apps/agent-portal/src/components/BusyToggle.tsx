import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn, formatDateTime, toast } from '@yiji/ui';
import { useAuth } from '../lib/auth/AuthContext.js';
import { getBusy, setBusy } from '../lib/job-producer.js';

/**
 * BUSY (owner, 2026-10-11).
 *
 * Signed in, but no new chats: the agent is on other work, or an admin opened
 * the account to monitor. Shown only to people chats are routed to (the
 * `receive_chats` privilege - WeCare Agent / Supervisor by default). Each
 * stretch is recorded for the Agent KPI "Busy time" report; signing out ends it.
 */
export function BusyToggle() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('receive_chats');
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['my-busy'],
    queryFn: getBusy,
    enabled: allowed,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: (next: boolean) => setBusy(next),
    onSuccess: (s) => qc.setQueryData(['my-busy'], s),
    onError: () =>
      toast.error(t('busy.failed', { defaultValue: 'Could not change your Busy status.' })),
  });
  if (!allowed) return null;
  const busy = state.data?.busy === true;
  const title = busy
    ? t('busy.onHint', {
        defaultValue: 'Busy since {{since}}: you get no new chats. Click to take chats again.',
        since: state.data?.since ? formatDateTime(state.data.since) : '',
      })
    : t('busy.offHint', {
        defaultValue: 'Mark yourself busy: you stay signed in but get no new chats.',
      });
  return (
    <button
      type="button"
      onClick={() => toggle.mutate(!busy)}
      disabled={toggle.isPending || state.isLoading}
      aria-pressed={busy}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold',
        'transition-colors duration-fast ease-out disabled:opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        busy
          ? 'bg-amber-500 text-white hover:bg-amber-600'
          : 'text-muted-foreground ring-1 ring-inset ring-foreground/15 hover:bg-secondary hover:text-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn('h-2 w-2 rounded-full', busy ? 'bg-white' : 'bg-emerald-500')}
      />
      {busy ? t('busy.on', { defaultValue: 'Busy' }) : t('busy.off', { defaultValue: 'Busy' })}
    </button>
  );
}
