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
   * ONE LINE, NAMING WHAT CHANGES AND FOR WHOM.
   *
   * Every gated surface is built from one commit and released together, so a
   * pending list of two entries is ONE update. What the owner needs to know is
   * not how many files moved but WHO sees the difference — the agents, the
   * customers, or both — because that is what decides whether now is a good
   * moment to press it.
   *
   * The admin portal is never in this list: it deploys immediately, which is
   * what keeps this button from being trapped inside the build it releases.
   */
  const surfaces = [...new Set(pending.map((p) => p.app))];
  const versions = [...new Set(pending.map((p) => p.version))];
  const newest = versions[0] ?? '';
  const who = surfaces.join(' + ');

  return (
    <div
      role="status"
      /*
       * A DARK STRIP, because this is an action and not a reading.
       *
       * It was a pale primary tint, which on a board made of pale tinted cards
       * read as one more panel to skim past (owner, 2026-09-16). `ink` is the
       * console's existing dark surface — the same one the "a newer version is
       * available" banner uses — so the page gains a deliberate accent rather
       * than a new colour nobody chose.
       */
      className="flex flex-wrap items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-sm text-ink-foreground shadow-float ring-1 ring-ink-foreground/15"
    >
      <span className="font-medium text-ink-foreground">
        {t('releases.pendingFor', {
          defaultValue: 'An update is waiting for the {{who}}.',
          who,
        })}
      </span>
      {/* Muted ON THE DARK GROUND, not the page's muted token — that is tuned
          for a light surface and would sit almost invisible here. */}
      <span className="text-xs text-ink-foreground/70">
        {/* The version is secondary — useful for matching against a release
            note, not the thing that decides whether to press the button. It is
            omitted entirely when CI could not record it, rather than showing
            the "unreleased build" placeholder as if it were a version. */}
        {newest && newest !== 'unreleased build'
          ? t('releases.hintVersion', {
              defaultValue: '{{version}} · nobody sees it until you apply it.',
              version: newest,
            })
          : t('releases.hint', {
              defaultValue: 'Nobody sees it until you apply it.',
            })}
      </span>
      <Button
        type="button"
        size="sm"
        /* Light on the dark strip: the default primary fill is tuned for a pale
           surface and loses its edge here. */
        className="ms-auto bg-ink-foreground text-ink hover:bg-ink-foreground/90"
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
