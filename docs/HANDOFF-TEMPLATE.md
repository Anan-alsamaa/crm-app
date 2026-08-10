# Contributor handoff template

For a collaborator who works **outside this repository** — no GitHub access, no
Directus, no AWS — and hands their work to the maintainer to integrate.

The maintainer pastes what comes back into their Claude Code session, which applies
it against the real codebase, runs `pnpm verify`, and commits.

---

## Preferred: send a patch, not a description

If any code was written, send the diff. It carries the exact change; a summary
carries only the intent, and the difference between the two is where bugs are born.

```bash
git diff main...my-branch > handoff.patch      # everything vs main
# or, if not using branches:
git diff > handoff.patch                       # uncommitted work
```

Attach `handoff.patch` **plus** the summary below. The summary explains _why_, the
patch supplies _what_ — the maintainer needs both to review it properly.

No repository access is required to produce a patch.

---

## Prompt to paste into the contributor's Claude

> Summarise everything we built in this session as a handoff document for another
> engineer who will re-implement it in the real repository. They cannot see our
> code or our conversation, so anything you leave out is lost.
>
> Use exactly these headings:
>
> **1. What changed, in one paragraph** — the user-visible outcome, not the method.
>
> **2. Files** — every file created or modified, with its full path and one line on
> what changed in it. If paths were guessed rather than known, say so explicitly.
>
> **3. Behaviour** — for each change: what the user sees before, what they see
> after, and the exact trigger. Name real UI labels, routes and field names.
>
> **4. Data and API** — any collection, field, endpoint or environment variable
> touched, including anything ADDED. Flag anything requiring a schema change.
>
> **5. Decisions and trade-offs** — what was chosen, what was rejected, and why. The
> reasoning matters more than the conclusion; it is what stops the receiving
> engineer re-litigating a settled question.
>
> **6. Not done / known broken** — anything incomplete, stubbed, hard-coded, or
> working only under specific conditions. Be blunt. Silent gaps are the single most
> expensive thing to hand over.
>
> **7. How to verify** — the click path that proves it works, and what to expect at
> each step.
>
> Rules:
>
> - Do not claim anything was tested unless it actually ran and passed. Say "not
>   run" where that is true.
> - Do not invent file paths, field names or component names. Mark uncertainty.
> - Keep it factual. No summary of how well it went.

---

## Maintainer checklist on receipt

1. Read section **6** first. It decides whether this is ready to integrate at all.
2. Apply the patch if one was sent: `git apply --check handoff.patch` before
   `git apply` — check first, so a bad patch fails loudly instead of half-applying.
3. Verify the claims in section **2** against the real tree. Paths from an
   environment without the repository are frequently wrong, and a plausible-looking
   wrong path is worse than an admitted guess.
4. Run `pnpm verify`. Treat section 7's click path as the acceptance test.
5. Check section **5** against `DESIGN.md` and `PRODUCT.md`. A decision that
   contradicts a settled one is a conversation, not a merge.
