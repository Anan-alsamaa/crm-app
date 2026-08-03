# Stream archive (June 2026)

Working notes from the period when this project was developed across three
parallel streams — **frontend**, **infra**, **quality** — each in its own git
worktree (`crm-app-frontend/`, `crm-app-infra/`, `crm-app-quality/`).

Those worktrees are gone. Every branch they held was merged into `main`, which
is a strict superset of all of them; the directories were removed so there is
one checkout and one branch. These files were the only content that lived
**nowhere else** — they were never committed to any branch — so they are
preserved here rather than lost.

## What this is, and is not

**Not** current documentation. For that, see:

| Topic                     | Read instead                                                      |
| ------------------------- | ----------------------------------------------------------------- |
| Deploy / operate          | [`docs/PRODUCTION.md`](../docs/PRODUCTION.md)                     |
| Cutover readiness         | [`docs/GO-LIVE-READINESS.md`](../docs/GO-LIVE-READINESS.md)       |
| Deploy topology + env     | [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)                     |
| Feature spec + data model | [`specs/001-yiji-crm-platform/`](../specs/001-yiji-crm-platform/) |

These are **point-in-time snapshots from June 2026**. They describe branch
topology, runtime state, and open risks as they were _before_ the streams
converged — much of which no longer holds. Treat any claim here as historical
unless you have re-verified it against the current tree.

## Contents

- **`infra/`** (20) — the largest set: security audits and sign-offs, branch
  convergence reports, repository audit, runtime reconciliation, an AWS
  deployment plan, a staging cutover plan, and a project-bible draft.
- **`frontend/`** (4) — frontend audit, convergence report, final handover, and
  a session export.
- **`quality/`** (3) — critical-findings verification, project risk assessment,
  and a session export.

Kept for the reasoning they record — why a decision was made, what an audit
found — which the code and git history do not capture on their own.
