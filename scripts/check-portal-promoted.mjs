#!/usr/bin/env node
/**
 * IS THE PORTAL THE OWNER SEES THE ONE WE SHIPPED?
 *
 * The agent portal and chat widget park behind "Update now": a production
 * deploy uploads the new pages to `pending/` and the owner promotes them with
 * a button. The admin portal is never gated.
 *
 * So a release can be entirely successful — services deployed, 4/4
 * digest-verified, zero downtime — and **reach nobody**. That is exactly what
 * happened: on 2026-10-05 the owner reported a fix missing from production that
 * had been built, tagged and sitting in `pending/` for THREE releases
 * (v1.35.0, v1.36.0, v1.37.0), while every release report said "live on
 * production, 4/4 digest-verified". True of the services, quietly false of the
 * UI.
 *
 * Finding that out took downloading 31 JavaScript chunks and grepping them,
 * because the component lived in a shared chunk rather than the one named
 * after the feature. This script answers the same question in two requests, so
 * nobody has to do that again.
 *
 * READ-ONLY. Fetches public pages and nothing else; changes nothing.
 *
 *   node scripts/check-portal-promoted.mjs            # prod (default)
 *   node scripts/check-portal-promoted.mjs --staging
 *   node scripts/check-portal-promoted.mjs --strict   # exit 1 if work is parked
 */

const STAGING = process.argv.includes('--staging');
const STRICT = process.argv.includes('--strict');

/**
 * The gated surfaces, and only those.
 *
 * The admin portal is deliberately absent: it is never gated, because the
 * "Update now" button would otherwise be trapped inside the build it releases.
 */
const SURFACES = STAGING
  ? [
      { name: 'agent portal', url: 'https://crm-agent-staging.anan.sa' },
      { name: 'chat widget', url: 'https://crm-staging.anan.sa' },
    ]
  : [
      { name: 'agent portal', url: 'https://crm-agent.anan.sa' },
      { name: 'chat widget', url: 'https://crm.anan.sa' },
    ];

/** The hashed entry bundle a page loads, e.g. `/assets/index-5uD-NacL.js`. */
function entryOf(html) {
  // The LAST match, not the first: a page may preload before it loads.
  const all = [...html.matchAll(/(?:src|href)="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

async function get(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return { status: res.status, body: res.ok ? await res.text() : '' };
  } catch (err) {
    return { status: 0, body: '', error: err.message };
  }
}

let parked = 0;
let broken = 0;

console.log(`\nPortal promotion — ${STAGING ? 'STAGING' : 'PRODUCTION'}\n`);

for (const s of SURFACES) {
  const live = await get(`${s.url}/`);
  if (live.status !== 200) {
    console.log(`  ${s.name}: LIVE PAGE UNREACHABLE (HTTP ${live.status}) ${live.error ?? ''}`);
    broken += 1;
    continue;
  }
  const liveEntry = entryOf(live.body);

  const pending = await get(`${s.url}/pending/index.html`);

  /*
   * NOTHING PARKED IS THE CORRECT ANSWER, and it is the only answer staging
   * can give: the `pending/` upload happens inside the GATED branch of the
   * deploy, which staging never takes. This must not read as a failure.
   *
   * 403 means the same as 404 here. S3 answers `AccessDenied` rather than
   * `NoSuchKey` for a missing object when the bucket policy does not grant
   * `s3:ListBucket` — which is the stricter and more usual configuration, and
   * is what the widget bucket does. Treating 403 as "could not check" reported
   * a fault on a surface that was simply up to date.
   */
  if (pending.status === 404 || pending.status === 403) {
    console.log(`  ${s.name}: up to date — nothing parked`);
    console.log(`      live: ${liveEntry ?? '(no hashed entry)'}`);
    continue;
  }

  if (pending.status !== 200) {
    console.log(`  ${s.name}: could not read pending/ (HTTP ${pending.status})`);
    broken += 1;
    continue;
  }

  const pendingEntry = entryOf(pending.body);

  /*
   * THE SIGNAL IS THE DIFFERING HASH, not the mere existence of `pending/`.
   * The directory survives a promotion, so an identical hash means the parked
   * build has already been promoted and is simply still sitting there.
   */
  if (liveEntry && pendingEntry && liveEntry === pendingEntry) {
    console.log(`  ${s.name}: up to date — parked build already promoted`);
    console.log(`      both: ${liveEntry}`);
    continue;
  }

  parked += 1;
  console.log(`  ${s.name}: *** AN UPDATE IS PARKED, NOT YET VISIBLE TO ANYONE ***`);
  console.log(`      live:   ${liveEntry ?? '(no hashed entry)'}`);
  console.log(`      parked: ${pendingEntry ?? '(no hashed entry)'}`);
  console.log(`      -> the owner must press "Update now" in the ${s.name}`);
}

console.log('');
if (broken) {
  console.log(`${broken} surface(s) could not be checked.`);
}
if (parked) {
  console.log(
    `${parked} surface(s) have work the owner cannot see yet.\n` +
      `Do NOT report those changes as live on production.`,
  );
} else if (!broken) {
  console.log('Every gated surface is serving its latest build.');
}

/*
 * Exit 0 by default, even with work parked: a parked build is a normal state
 * between a deploy and the owner's click, so failing a pipeline on it would
 * make the gate itself look broken. `--strict` is for a post-release check,
 * where "still parked" is the thing somebody needs to be told.
 */
process.exit(STRICT && (parked || broken) ? 1 : 0);
