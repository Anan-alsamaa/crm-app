import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The newest PRODUCTION release (a `v*` tag is the prod release) and whether
 * the gated UI it carried is actually visible.
 *
 * Read-only by construction: `git tag`, `git for-each-ref`, `git ls-remote`
 * (none of them change the repo — no fetch), and the existing
 * `scripts/check-portal-promoted.mjs`, which only GETs public pages.
 */

async function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { timeout, windowsHide: true });
  return stdout.trim();
}

const semverDesc = (a: string, b: string) => {
  const pa = a
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  const pb = b
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

export async function releaseStatus(repo: string): Promise<string> {
  const out: string[] = [];

  try {
    const tags = (await git(repo, ['tag', '--list', 'v*', '--sort=-v:refname']))
      .split(/\r?\n/)
      .filter(Boolean);
    const newest = tags[0];
    if (!newest) {
      out.push('Local repo has no v* tags.');
    } else {
      const info = await git(repo, [
        'for-each-ref',
        `refs/tags/${newest}`,
        '--format=%(contents:subject)%09%(creatordate:iso-strict)',
      ]);
      const [subject, date] = info.split('\t');
      out.push(`Newest local v* tag: ${newest} (${date ?? '?'})`, `  subject: ${subject ?? '-'}`);
      if (tags.length > 1) out.push(`  previous: ${tags.slice(1, 4).join(', ')}`);
    }
    try {
      const remote = (await git(repo, ['ls-remote', '--tags', '--refs', 'origin', 'v*'], 20_000))
        .split(/\r?\n/)
        .map((l) => l.split('refs/tags/')[1])
        .filter((t): t is string => Boolean(t))
        .sort(semverDesc);
      if (remote[0]) {
        out.push(
          remote[0] === newest
            ? `  origin agrees: newest remote tag is ${remote[0]}`
            : `  NOTE: origin's newest tag is ${remote[0]} — local tags are behind (git fetch --tags to see its subject)`,
        );
      }
    } catch {
      out.push('  (could not reach origin to compare tags; showing local tags only)');
    }
  } catch (err) {
    out.push(`git failed: ${(err as Error).message.split('\n')[0]}`);
  }

  out.push('', 'Gated UI (agent portal + chat widget behind "Update now"):');
  const script = path.join(repo, 'scripts', 'check-portal-promoted.mjs');
  if (!existsSync(script)) {
    out.push(`  scripts/check-portal-promoted.mjs not found under ${repo}`);
  } else {
    try {
      const { stdout } = await run(process.execPath, [script], {
        timeout: 30_000,
        windowsHide: true,
      });
      out.push(
        ...stdout
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^Portal promotion/.test(l.trim()))
          .map((l) => `  ${l.trim()}`),
      );
    } catch (err) {
      out.push(`  check failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return out.join('\n');
}
