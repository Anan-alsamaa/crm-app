# Dependency advisories: what is real, and what is not

GitHub reports a large Dependabot number on this repo. Most of it is not
actionable, and the danger of leaving it unexplained is that the next person to
look sees ~95 alerts, assumes the whole thing is noise, and misses the one that
matters. This is the triage, so it does not have to be redone from scratch.

Last full triage: **2026-08-12**, against `main`.

## The shape of it

| Source                                | Count | Actionable?               |
| ------------------------------------- | ----- | ------------------------- |
| `directus/local/package-lock.json`    | 58    | No — see below            |
| Our `pnpm-lock.yaml`, already patched | 21    | No — stale alerts         |
| Genuinely outdated in our code        | 2     | One fixed, one deliberate |

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

**The only real fix is upgrading Directus 11 → 12**, which is a major upgrade
of the system holding all customer data: schema migrations, extension
compatibility, and `directus/bootstrap` (which targets the 11 API). That is a
deliberate project, not a dependency bump.

**Current decision (2026-08-12): stay on Directus 11 throughout.** These alerts
are accepted risk under that decision. If that changes, revisit this file
first — the alert count should drop by ~58 on the upgrade.

## Stale alerts on our lockfile (21)

Verified individually against installed versions: `react-router`,
`nodemailer`, `js-yaml`, `fast-uri`, `postcss`, `vite`, `vitest`,
`socket.io-parser`, `find-my-way`, `protobufjs`, `form-data`,
`@opentelemetry/propagator-jaeger` are all at or above their fixed versions.

`brace-expansion` deserves a note because it looks wrong and is not: it ships
three release branches at once, and the advisory lists a first-patched version
per branch. We carry 1.1.18, 2.1.4 and 5.0.9 — each at or above the fix for its
own branch. Comparing 1.1.18 against the 5.x fix makes it look unpatched.

These close when Dependabot rescans; nothing to do.

## Genuinely outdated (2)

- **`@babel/core`** — arbitrary file read via a `sourceMappingURL` comment.
  Fixed: bumped inside our existing range, lockfile resolves to 7.29.7.
- **`esbuild` 0.25.12** — arbitrary file read in its **development server on
  Windows**. Deliberately not forced. Production serves static files through
  nginx and never runs that server, and vite 6 constrains esbuild to `^0.25.0`,
  so an override would risk every build for something that cannot reach
  production. It wants a considered vite major on its own.

## How to redo this triage

Do not read the alert count. Compare what is _installed_ against what each
advisory says is fixed:

```bash
gh api "repos/<owner>/<repo>/dependabot/alerts?state=open&per_page=100" --paginate \
  --jq '.[] | [.security_advisory.severity, .dependency.package.name,
               (.dependency.scope//"runtime"), (.dependency.manifest_path//"?"),
               (.security_vulnerability.first_patched_version.identifier//"NONE")] | @tsv'
```

Then check each package's resolved version in `pnpm-lock.yaml`. A package with
several major branches needs comparing against the fix **for its own branch**.
