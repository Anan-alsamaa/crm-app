# Directus schema snapshot

The **programmatic bootstrap** in `directus/bootstrap/` is the reproducible
source of truth for the schema (collections, fields, relations, junctions,
roles, permissions) and is what `pnpm --filter @yiji/directus-bootstrap apply`
runs against a fresh Directus instance.

After the first successful `apply`, capture a Directus-native snapshot here so
the schema can also be re-applied via the Directus CLI:

```bash
# inside the directus container (or with DIRECTUS_* env set)
npx directus schema snapshot ./directus/snapshot/schema.yaml
```

Commit the regenerated `schema.yaml` on **every schema change** (spec Approach
Notes). Re-apply with:

```bash
npx directus schema apply ./directus/snapshot/schema.yaml
```

> The snapshot file is intentionally not committed yet because it is generated
> from a running instance, which requires Docker (not available in the current
> dev environment). The bootstrap scripts fully reproduce the schema in the
> meantime.
