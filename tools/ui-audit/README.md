# UI audit

Walks every route in both portals, signed in, and reports what is broken.

```bash
node tools/ui-audit/index.mjs          # both portals (needs them running)
PORTAL=agent node tools/ui-audit/index.mjs
```

Exits non-zero when it finds anything, so it can gate a release.

## Why this exists

Defects were being found by the owner, one at a time, and fixing one page kept
surfacing another. Nothing looked at all thirty-three routes together. This
does, in about ninety seconds.

## What it reports

Only things that are defects by construction — never matters of taste:

- an unresolved i18n placeholder (`{{count}}` reaching the screen)
- `undefined`, `NaN`, `[object Object]`, `Invalid Date`
- a raw translation key rendered instead of its translation
- the error boundary, or a "could not load" state
- any uncaught exception or console error
- any request that failed (4xx/5xx), except the pre-session `/auth/refresh`
- a route that lands somewhere other than itself, unless it is a known alias

## What it cannot tell you

Whether the design is any good. It catches breakage, not taste. Keep the
radius scale (`full` pills · `2xl` containers · `xl` fields · `md` chips)
and the ink/paper split by review, not by this.
