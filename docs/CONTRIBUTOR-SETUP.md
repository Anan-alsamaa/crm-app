# Contributor setup — UI work without installing anything

For a collaborator working on the **portals** (agent + admin UI). It deliberately
avoids Docker, Postgres, and any local toolchain install.

## What you need

A browser and a GitHub account with access to this repository. Nothing else.

## Start

1. Open the repository on GitHub → **Code** → **Codespaces** → **Create codespace on
   your branch**.
2. Wait ~2 minutes. It installs Node 20, pnpm and the project's dependencies for
   you — the same versions CI uses, so "works on my machine" cannot happen.
3. In the terminal:

   ```bash
   pnpm --filter @yiji/agent-portal dev    # Agent portal  → port 5173
   pnpm --filter @yiji/admin-portal dev    # Admin portal  → port 5174
   ```

4. A notification offers to open the forwarded port. That URL is your live preview,
   with hot reload — edit a file, the browser updates.

The preview URL is **private to your Codespace**. Nobody else can open it.

## Connecting to data

The portals read their backend from `VITE_*` variables. Create `.env.local` in the
portal you are working on:

```
VITE_DIRECTUS_URL=<the dev Directus URL you were given>
VITE_SOCKET_URL=<the dev gateway URL you were given>
VITE_AI_GATEWAY_URL=<the dev AI gateway URL you were given>
```

Ask the maintainer for these. **There is no local database to set up** — the portals
are a client, and pointing them at a running Directus is all that is required.

> Never point these at production. A Codespace has real write access to whatever it
> is aimed at, and a UI experiment against live data is a data incident.

## Before you push

```bash
pnpm verify
```

This is the same gate CI runs: formatting, lint, types, and every test suite. A pull
request cannot merge while it is red, so running it locally saves a round trip.

## Working agreement

- Work on a **branch**. `main` is protected; direct pushes are rejected.
- Open a **pull request** when ready. A maintainer reviews and merges.
- **Do not modify**: `.github/`, `deploy/`, `docker-compose*.yml`, any `Dockerfile`,
  `directus/bootstrap/`, `package.json`, `pnpm-lock.yaml`, or tsconfig / eslint /
  prettier configuration. These are release and infrastructure plumbing; changes
  there need a maintainer. If your work seems to need one, say so in the PR
  description rather than editing it.
- Read `CLAUDE.md`, `PRODUCT.md` and `DESIGN.md` first. `DESIGN.md` in particular
  records design decisions that were already argued and settled — reopening them in
  a PR wastes both our time.

## If something breaks

Delete the Codespace and create a new one. Nothing lives on your machine, so a
broken environment costs two minutes rather than an afternoon.
