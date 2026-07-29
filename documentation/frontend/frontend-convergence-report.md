# Frontend Convergence Report — `001-yiji-crm-platform` vs `stream/frontend`

**Date:** 2026-06-24
**Method:** Read-only git comparison of `origin/001-yiji-crm-platform` against `origin/stream/frontend` (both fetched fresh). No code modified.
**Repo:** `Anan-alsamaa/crm-app` (the four local working dirs — crm-app, crm-app-frontend, crm-app-infra, crm-app-quality — are checkouts of this one repo on different branches).

---

## TL;DR — Verdict

**`001-yiji-crm-platform` is safe to treat as the source of truth.** It is **strictly ahead** of `stream/frontend`. Every divergence is `stream/frontend` being _stale_ relative to 001 — there is **no feature, fix, or security improvement on `stream/frontend` that is missing from 001**.

The quality report's working assumption (that `main`/`001` is the deployable, converged line — e.g. `docs/GO-LIVE-READINESS.md`) **holds for the frontend**.

---

## Branch topology (the hard numbers)

```
merge-base = d87e9c0
git rev-list --left-right --count origin/001…origin/stream/frontend  →  10   1
```

- **001 is 10 commits ahead** of the merge base.
- **stream/frontend is 1 commit ahead** of the merge base.
- That **1 commit** is `7c46921 fix(deploy): no-cache the portal SPA shell in the container images`.
  - It is **functionally identical** to `3cedb4b` already in 001 (same two files, same `+8/-2` diffstat — the same change landed on both branches with different hashes, via PR #29).
  - **Net effect: zero unique work on stream/frontend.**

### What 001 has that stream/frontend lacks (the 10 commits)

```
ef31b01  Merge PR #33  — gate app services behind Compose `app` profile (hybrid-safe up)
8bd73ba  Merge PR #30  — cache-headers hardening into 001
93c1358  fix(infra)    — Compose `app` profile
629a113  Merge PR #32  — fix stale ticket first-response E2E selector
5607da1  Merge PR #31  — Linux frontend build + strip widget demo page
80a58cf  test(e2e)     — first-response selector fix ("Mark first response")
fd8c21c  deploy        — Linux frontend build from single repo + strip widget demo page
3cedb4b  fix(deploy)   — no-cache portal SPA shell in container images
1872764  fix(deploy)   — no-cache portal SPA shell in nginx edge config
ecd655c  Merge PR #29  — converge frontend stream (features + security) into 001
```

PR #29 is the explicit convergence point: _"converge frontend stream (features + security) into 001."_ PRs #30–#33 then advanced 001 **past** stream/frontend with deploy/CI/infra hardening.

---

## 1. Features present in `stream/frontend` but absent in 001

**None.**

No frontend application source differs. A targeted diff of all app/package source and portal Dockerfiles returns empty:

```
git diff --name-only origin/001 origin/stream/frontend -- 'apps/**/src/**' 'packages/**/src/**' 'apps/**/Dockerfile'
→ (empty)
```

All widget/agent/admin/shared-package source code is **byte-identical** between the two branches. Every feature on stream/frontend is in 001.

## 2. Fixes present in `stream/frontend` but absent in 001

**None.** The reverse is true — 001 carries fixes stream/frontend is **missing**:

- **E2E ticket selector fix (PR #32 / 80a58cf):** stream/frontend still has the **stale** selector `getByRole('button', { name: /mark first response sent/i })`; 001 has the corrected `/mark first response/i` matching the actual button label. _stream/frontend would fail this E2E test._

## 3. Security improvements present in `stream/frontend` but absent in 001

**None.** The lone security/deploy hardening on stream/frontend — the **no-cache SPA shell** in the portal container images (`7c46921`) — is **already in 001** (`3cedb4b`, identical). 001 additionally has security/cache hardening stream/frontend lacks:

- **Cache-header hardening at the nginx edge config (PR #30 / 1872764)** — not on stream/frontend.
- **Compose `app` profile (PR #33 / 93c1358)** — prevents the Docker/PM2 collision; hardens the hybrid run path. Not on stream/frontend.

## 4. Files that differ materially

10 files differ; **all show stream/frontend as the older side.** None represents lost frontend work.

| File                                          | Nature of difference                                                | Which side is newer                      |
| --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `apps/agent-portal/tests/e2e/tickets.spec.ts` | first-response button selector                                      | **001** (correct); stream/frontend stale |
| `README.md`                                   | `docker compose up` → `--profile app` guidance                      | **001**                                  |
| `specs/001-yiji-crm-platform/quickstart.md`   | same `--profile app` guidance                                       | **001**                                  |
| `specs/001-yiji-crm-platform/demo-guide.md`   | same `--profile app` guidance                                       | **001**                                  |
| `deploy/README.md`                            | Windows `build-frontend.ps1` → Linux `build-frontend.sh` prod build | **001**                                  |
| `deploy/build-frontend.sh`                    | **present in 001, absent in stream/frontend**                       | **001**                                  |
| `deploy/nginx/yiji-crm.conf`                  | present in 001, absent in stream/frontend                           | **001**                                  |
| `docker-compose.yml`                          | `app` profile block present in 001 only                             | **001**                                  |
| `start-infra.ps1`                             | present in 001, absent in stream/frontend                           | **001**                                  |
| `stop-infra.ps1`                              | present in 001, absent in stream/frontend                           | **001**                                  |

**No `apps/**/src`, `packages/**/src`, or portal `Dockerfile` differences.** The material differences are confined to docs, one E2E selector, and deploy/infra scaffolding — every one of them more advanced on 001.

## 5. Is 001 safe to treat as source of truth?

**Yes — unconditionally, for the frontend.**

- 001 is strictly ahead: it contains 100% of stream/frontend's frontend work plus PRs #29–#33.
- stream/frontend's only unique commit duplicates a change already in 001.
- stream/frontend is actively **behind** on a test fix (#32) and deploy hardening (#30, #31, #33) — deploying from it would regress.
- The quality report's premise that the converged line (001 → main) is the deployable artifact is **verified** for the frontend.

### Recommended housekeeping (optional, not blocking)

`stream/frontend` is now a stale integration branch. To prevent future "is something stranded on stream/frontend?" confusion, either **delete it** or **fast-forward/merge it from 001** so it stops diverging. This is a branch-hygiene action only — there is no code to recover from it.

---

### Provenance of claims in this report

- `git rev-list --left-right --count`, `git log`, `git diff --stat`, and scoped `git diff --name-only` between `origin/001-yiji-crm-platform` and `origin/stream/frontend` (post-`git fetch`).
- Quality report read: `crm-app-quality/docs/GO-LIVE-READINESS.md`, `docs/AUDITS.md`, `docs/quality-notes.md` (branch `stream/quality`).
- No working-tree files were modified.
