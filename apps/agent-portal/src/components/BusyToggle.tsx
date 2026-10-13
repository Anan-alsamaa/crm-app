import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn, formatDateTime, toast } from '@yiji/ui';
import { useAuth } from '../lib/auth/AuthContext.js';
import { getBusy, setBusy, type BusyState } from '../lib/job-producer.js';

/**
 * BUSY (owner, 2026-10-11).
 *
 * Signed in, but no new chats: the agent is on other work, or an admin opened
 * the account to monitor. Shown only to roles with the `mark_busy` privilege
 * (owner, 2026-10-13: the three WeCare roles by default, off for the rest -
 * the Administrator included, see ROLE_SPECIFIC_PRIVILEGES). Each
 * stretch is recorded for the Agent KPI "Busy time" report; signing out ends it.
 */
export function BusyToggle() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('mark_busy');
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['my-busy'],
    queryFn: getBusy,
    enabled: allowed,
    staleTime: 30_000,
  });
  /*
   * INSTANT (owner, 2026-10-11: "the button takes some time to reflect"). The
   * button flips the moment it is clicked; the server confirms behind it, and
   * a refusal flips it back with a message.
   */
  const toggle = useMutation({
    mutationFn: (next: boolean) => setBusy(next),
    onMutate: async (next: boolean) => {
      await qc.cancelQueries({ queryKey: ['my-busy'] });
      const before = qc.getQueryData<BusyState>(['my-busy']);
      qc.setQueryData<BusyState>(['my-busy'], {
        busy: next,
        since: next ? new Date().toISOString() : null,
      });
      return { before };
    },
    onSuccess: (s) => qc.setQueryData(['my-busy'], s),
    onError: (_err, _next, ctx) => {
      if (ctx?.before) qc.setQueryData(['my-busy'], ctx.before);
      toast.error(t('busy.failed', { defaultValue: 'Could not change your Busy status.' }));
    },
  });
  if (!allowed) return null;
  const busy = state.data?.busy === true;
  const title = busy
    ? t('busy.onHint', {
        defaultValue: 'Busy since {{since}}: you get no new chats. Click when you are ready.',
        since: state.data?.since ? formatDateTime(state.data.since) : '',
      })
    : t('busy.offHint', {
        defaultValue: 'Ready: new chats can come to you. Click to mark yourself busy.',
      });
  /* READY or BUSY, in words, always (owner, 2026-10-11). Busy keeps the
     yellow outline the owner liked. */
  return (
    <button
      type="button"
      onClick={() => toggle.mutate(!busy)}
      disabled={state.isLoading}
      aria-pressed={busy}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold',
        'transition-colors duration-fast ease-out disabled:opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        busy
          ? 'bg-amber-50 text-amber-700 ring-2 ring-inset ring-amber-500 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300'
          : 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-500/40 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300',
      )}
    >
      <span
        aria-hidden
        className={cn('h-2 w-2 rounded-full', busy ? 'bg-amber-500' : 'bg-emerald-500')}
      />
      {busy ? t('busy.on', { defaultValue: 'Busy' }) : t('busy.ready', { defaultValue: 'Ready' })}
    </button>
  );
}
