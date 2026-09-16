import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { JSX } from 'react';
import { Button, Spinner, toast } from '@yiji/ui';
import { jobProducer, type PendingBuild } from '../../lib/job-producer.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * "A new version is ready — Update now."
 *
 * PRODUCTION NO LONGER CHANGES BECAUSE CI WENT GREEN (owner, 2026-09-16). A
 * deploy publishes a build and stops: the new assets are uploaded and the new
 * entry point is parked, while the live `index.html` still names the old
 * bundle. Nobody sees anything. Updates stack up here, and production changes
 * when the administrator says so.
 *
 * Only shown to somebody with `admin_access`, and the gateway re-checks that on
 * the way in — this decides whether the button is offered, not whether it is
 * allowed.
 *
 * Deliberately quiet when there is nothing to do. A banner that is always
 * present is one people stop reading, and "up to date" is the ordinary state.
 */
export function UpdateBanner(): JSX.Element | null {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.admin_access === true;

  const releases = useQuery({
    queryKey: ['releases'],
    enabled: isAdmin,
    /* Checked on a timer as well as on mount: an administrator often has the
       console open when a deploy lands, and a banner that only appears on a
       page load would mean the update waits until they happen to navigate. */
    refetchInterval: 2 * 60_000,
    staleTime: 60_000,
    queryFn: () => jobProducer.listReleases(),
    /* A gateway that has no release configuration answers 503. That is not an
       error worth surfacing — it means this environment does not gate
       releases — so the banner simply stays hidden. */
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () => jobProducer.applyRelease(),
    onSuccess: (res) => {
      if (res.released === false) {
        toast.success(t('releases.alreadyCurrent', { defaultValue: 'Already up to date.' }));
      } else {
        toast.success(
          t('releases.applied', {
            defaultValue: 'Update applied. Everyone gets it on their next page load.',
          }),
        );
      }
      void qc.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (err: Error) => {
      // Named, not generic: the two real failures — no AWS credentials, and a
      // copy the bucket policy refused — need different people to fix them.
      toast.error(err.message || t('releases.failed', { defaultValue: 'Update failed.' }));
    },
  });

  if (!isAdmin) return null;
  const pending: PendingBuild[] = releases.data?.pending ?? [];
  if (pending.length === 0) return null;

  /*
   * ONE LINE, NAMING WHAT IS WAITING.
   *
   * Both portals are built from one commit and released together, so a pending
   * list of two entries is ONE update, not two. Counting distinct versions is
   * what makes the sentence true.
   */
  const versions = [...new Set(pending.map((p) => p.version))];
  const newest = versions[0] ?? '';

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-2xl bg-primary/10 px-4 py-3 text-sm ring-1 ring-primary/25"
    >
      <span className="font-medium text-foreground">
        {versions.length > 1
          ? t('releases.pendingMany', {
              defaultValue: '{{count}} updates are ready — newest is {{version}}.',
              count: versions.length,
              version: newest,
            })
          : t('releases.pendingOne', {
              defaultValue: 'Version {{version}} is ready to install.',
              version: newest,
            })}
      </span>
      <span className="text-xs text-muted-foreground">
        {t('releases.hint', {
          defaultValue: 'Nobody sees it until you apply it.',
        })}
      </span>
      <Button
        type="button"
        size="sm"
        className="ms-auto"
        disabled={apply.isPending}
        onClick={() => apply.mutate()}
      >
        {apply.isPending ? (
          <Spinner size={14} />
        ) : (
          t('releases.updateNow', { defaultValue: 'Update now' })
        )}
      </Button>
    </div>
  );
}
