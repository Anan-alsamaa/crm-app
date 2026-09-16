import { z } from 'zod';

/*
 * WHO DECIDES WHEN PRODUCTION CHANGES.
 *
 * Until now a deploy WAS the release: the pipeline overwrote `index.html`, and
 * every portal already open noticed the new bundle and nagged its own user to
 * reload. The change reached the floor the moment CI went green, and the
 * administrator found out at the same time as everybody else.
 *
 * The owner asked for the opposite (2026-09-16): a deploy should PUBLISH a
 * build and stop there, updates should stack up for the administrator, and
 * production should change when they press Update now — not before.
 *
 * WHY THIS IS ONLY ABOUT THE PORTALS. A backend deploy is a running server
 * being replaced; there is nothing to hold back once ECS has swapped the tasks.
 * The portals are static files, so the new bundle can sit in the bucket
 * unreferenced for as long as you like. Backend first, frontend on your word,
 * which is also the safe order: the API a released UI talks to is already
 * there.
 *
 * The mechanism is deliberately small. `index.html` is served `no-cache` and
 * names content-hashed assets, so RELEASING IS ONE FILE SWAP. Nothing else in
 * the bucket has to move, no CloudFront behaviour has to change, and a release
 * can be undone by swapping back.
 */

/** Where a build's `index.html` waits while it is published but not released. */
export const PENDING_INDEX_KEY = 'pending/index.html';

/**
 * `app_settings` keys holding the release state.
 *
 * Kept in `app_settings` rather than a new collection because it is exactly
 * what that collection is for — a handful of rows the operations team owns —
 * and a new collection would need its own permissions on two live
 * environments for two values.
 */
export const RELEASE_KEYS = {
  /** The build currently SERVED. Written when a release is applied. */
  live: 'release.live',
  /** Builds published and waiting. A JSON array, newest first. */
  pending: 'release.pending',
} as const;

/**
 * One published build.
 *
 * `indexHtml` is the whole point: it is the released artefact, captured at
 * publish time. Storing the file itself rather than a pointer means a release
 * cannot be broken by anything that happens to the bucket in between, and the
 * administrator releases the exact bytes CI produced.
 */
export const PublishedBuild = z.object({
  /** The git tag for a production build, or the branch for staging. */
  version: z.string().min(1),
  /** Short commit sha, so a version can be traced to code. */
  commit: z.string().min(1),
  /** ISO timestamp of when CI published it. */
  publishedAt: z.string().min(1),
  /** Which portal this build is for. They are deployed and released together. */
  app: z.enum(['agent', 'admin']),
  /**
   * The bundle this build's `index.html` names, e.g. `/assets/index-B8urTZ4R.js`.
   *
   * Lets the admin portal say what is pending WITHOUT fetching anything from
   * S3, and lets a release verify that the assets it is about to point at were
   * actually uploaded — the one failure that would show users a blank page.
   */
  bundle: z.string().min(1),
});
export type PublishedBuild = z.infer<typeof PublishedBuild>;

/** A release the administrator has applied. */
export const AppliedRelease = PublishedBuild.extend({
  /** ISO timestamp of the click. */
  releasedAt: z.string().min(1),
  /** The administrator who released it, for the audit trail. */
  releasedBy: z.string().nullable(),
});
export type AppliedRelease = z.infer<typeof AppliedRelease>;

/** The pending list, newest first. Empty when production is up to date. */
export const PendingReleases = z.array(PublishedBuild);
export type PendingReleases = z.infer<typeof PendingReleases>;

/**
 * Is this build already the live one?
 *
 * Compared on VERSION AND BUNDLE, not version alone. A version can be
 * republished — a rebuild of the same tag produces a different bundle hash —
 * and treating those as the same build would leave a genuinely newer artefact
 * looking already-released, which is the quiet kind of wrong that ends with
 * somebody insisting a fix was never deployed.
 */
export function isSameBuild(
  a: { version: string; bundle: string } | null | undefined,
  b: { version: string; bundle: string } | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.version === b.version && a.bundle === b.bundle;
}
