# Dependency advisories: what is real, and what is not

GitHub reports a large Dependabot number on this repo. Most of it is not
actionable, and the danger of leaving it unexplained is that the next person to
look sees ~95 alerts, assumes the whole thing is noise, and misses the one that
matters. This is the triage, so it does not have to be redone from scratch.

Last full triage: **2026-08-12**, against `main`.

## The shape of it

| Source                                | Count | Actionable?       |
| ------------------------------------- | ----- | ----------------- |
| `directus/local/package-lock.json`    | 58    | No — see below    |
| Our `pnpm-lock.yaml`, already patched | 36    | No — stale alerts |
| Genuinely outdated in our code        | 1     | Fixed             |

## Directus 11's own dependency tree (58)

`directus/local` is a dev-only SQLite Directus instance ("run without Docker",
not part of the pnpm workspace). Its `package-lock.json` is committed so local
setups are reproducible, and Dependabot scans it — which is why the alerts are
attributed there.

They are **not** dev-only in effect. Production runs `directus/directus:11`
(see `docker-compose.prod.yml`), which is the same dependency tree. So do not
dismiss these as "just the dev instance".

They are nonetheless not fixable while we are on Directus 11:

- `directus@11.17.4` is the **last 11.x release**; upstream has moved to 12.x.
  There is no patch to take.
- Regenerating the lockfile is a no-op — verified, byte-identical. Those
  versions are pinned by Directus itself, not by our ranges.
- `npm audit fix --force` inside `directus/local` would pull Directus 12 and
  break parity with production.

Upgrading to Directus 12 would clear them, and **that is not happening**.

> **Standing decision (2026-08-12): this project stays on Directus 11.**
> Not "for now" — permanently. Do not propose, scope or cost a Directus 12
> upgrade, including as the remedy for these advisories.

This is worth stating plainly because every dependency-security pass
rediscovers the same 58 alerts and arrives at the same tempting conclusion. It
has been considered and rejected. Re-raising it wastes a review cycle.

These alerts are therefore **accepted risk**, and are dismissed on GitHub with
that reason recorded. Be honest about what that means: dismissing them recorded
a decision, it did not remove the exposure. Any real mitigation has to work
_within_ Directus 11 — network exposure, reverse-proxy rules, access scoping —
rather than by moving off it.

## Stale alerts on our lockfile (36)

Verified against the locked versions, not the alert text: `react-router`,
`nodemailer`, `js-yaml`, `fast-uri`, `postcss`, `vite`, `vitest`,
`socket.io-parser`, `find-my-way`, `protobufjs`, `form-data`, `esbuild` and
`@opentelemetry/propagator-jaeger` all sit outside their advisory ranges.

`brace-expansion` deserves a note because it looks wrong and is not: it ships
three release branches at once, and the advisory lists a first-patched version
per branch. We carry 1.1.18, 2.1.4 and 5.0.9 — each at or above the fix for its
own branch. Comparing 1.1.18 against the 5.x fix makes it look unpatched.

These close when Dependabot rescans; nothing to do.

## Genuinely outdated (1)

- **`@babel/core`** — arbitrary file read via a `sourceMappingURL` comment.
  Fixed: bumped inside our existing range, lockfile resolves to 7.29.7.

**`esbuild` is NOT one of them**, though it looks like it. The advisory (an
arbitrary file read in its dev server on Windows) applies to
`>= 0.27.3, < 0.28.1`. We lock 0.25.12, which is _below_ that range, and 0.28.1.
Neither is affected. Reading only `first_patched_version` and concluding
"0.25.12 < 0.28.1, so we are exposed" is wrong, and would have cost a needless
vite major.

## How to redo this triage

Do not read the alert count — it measures Dependabot's scan lag, not exposure.
Run:

```bash
pnpm check:advisories
```

It compares every open advisory against what `pnpm-lock.yaml` actually
resolves, and exits non-zero only on real exposure. Two traps it encodes,
because both are easy to get wrong by hand and both produce confident
nonsense:

- **Lower bounds.** Ranges look like `>= 0.27.3, < 0.28.1`. A version below the
  lower bound is a different release branch and is not affected. This is also
  what makes `brace-expansion` fine at 1.1.18 / 2.1.4 / 5.0.9 — it ships three
  branches at once and gets one advisory per branch.
- **Types packages.** `@types/nodemailer@6.4.23` is not `nodemailer@6.4.23`. A
  loose substring match invents an exposure that does not exist; entries must
  be matched anchored.

Status at the last run (2026-08-12): **CLEAN** — all 37 open alerts on our
manifests are against packages already patched here, awaiting rescan.
