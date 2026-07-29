/**
 * Compensation ops queue — schema provisioning.
 *
 * The agent portal ships an unconditional `/compensation` route (App.tsx nav),
 * but until now NOTHING in the deploy path created the collections it reads.
 * They existed locally only because someone ran the ad-hoc scripts in
 * `directus/compensation-clone/` by hand, so on a clean bootstrap every ops
 * agent hit a 403 on a nav item they can see. This module closes that gap by
 * applying the same five collections from the SAME schema snapshots the clone
 * scripts use (`directus/compensation-clone/schema/`, extracted read-only from
 * production) — no second source of truth.
 *
 * Scope, deliberately:
 *   - SCHEMA ONLY. Purely additive: creates a collection that is absent and adds
 *     a field/relation that is absent. It never alters or drops anything, so it
 *     is safe to run against a Directus that already owns these collections.
 *   - Admin-form layout fields (tabs/groups/super-header/links) are skipped —
 *     they are `alias` fields for the Directus form, and the portal renders its
 *     own UI. Same exclusion the clone scripts make.
 *   - Agent permissions live in roles.ts (declarative, like every other role).
 *   - FLOWS ARE NOT CREATED HERE. The workflow buttons are Directus manual flows
 *     triggered by fixed id (flow-contract.json). Production owns the real ones
 *     (they call the Yiji AddCoupon API); `standin-flows.mjs` builds offline
 *     look-alikes that make no external calls and must never ship to prod.
 *     verify.ts reports which flow ids are missing instead of guessing.
 */
import {
  createCollection,
  createField,
  createRelation,
  readCollections,
  readFieldsByCollection,
  readRelations,
} from '@directus/sdk';
import fs from 'node:fs';

/** Minimal structural view of the bootstrap's Directus client. */
type Client = { request: (options: never) => Promise<unknown> };

/** Swallows "already exists"; rethrows anything else. Supplied by apply.ts. */
type Idempotent = (label: string, fn: () => Promise<unknown>) => Promise<void>;

/**
 * Creation order matters: dependencies first, so each m2o target exists before
 * the relation that points at it. `compensation_requests` is last because it
 * references all four others.
 */
export const COMPENSATION_COLLECTIONS = [
  'Com_Issue_Categories',
  'Com_Coupons',
  'com_issues_list',
  'Compensation_Request_items',
  'compensation_requests',
] as const;

/**
 * The ONLY fields an ops agent may write directly. Everything else on a request
 * (status, computed values, coupon links) is written by the flows, which run
 * with their own accountability. Mirrors grant-agent-perms.mjs: these are the
 * workflow INPUTS — the classification that drives the SLA timers and the
 * compensation rules (`com_issue`, `complaint_type`) plus the order/items data
 * those rules read. Consumed by roles.ts.
 */
export const COMPENSATION_OPS_EDITABLE_FIELDS = [
  'com_issue',
  'complaint_type',
  'order_total',
  'delivery_fee',
  'user_complaint_amount',
  'items_with_issue',
];

/**
 * Relation targets that already exist and must never be created by this module:
 * Directus system collections plus the CRM's own `sla_policies` (the compensation
 * issue catalog reuses it). Any relation pointing outside this set OR the five
 * collections above is skipped — the snapshots also mention prod-only rule
 * collections (`Com_Issues_c`, `Com_Issues_t`) that are not part of the clone.
 */
const EXTERNAL_TARGETS = new Set(['directus_users', 'directus_files', 'sla_policies']);

const SNAPSHOT_DIR = new URL('../../compensation-clone/schema/', import.meta.url);

/** Which snapshot file holds each collection's fields. */
const FIELD_SNAPSHOTS: Record<string, string> = {
  Com_Issue_Categories: 'dep_Com_Issue_Categories_fields.json',
  Com_Coupons: 'dep_Com_Coupons_fields.json',
  com_issues_list: 'dep_com_issues_list_fields.json',
  Compensation_Request_items: 'dep_Compensation_Request_items_fields.json',
  compensation_requests: 'fields.json',
};

/** False when the image/checkout was built without `compensation-clone/schema`. */
export function compensationSnapshotsPresent(): boolean {
  return fs.existsSync(SNAPSHOT_DIR);
}

/**
 * The manual flows the portal's workflow buttons trigger by fixed id. Read from
 * the same contract the portal and the clone scripts use, so the three can never
 * disagree about an id. Provisioning them is out of scope (see the header note);
 * verify.ts uses this list to REPORT which ones an environment is missing.
 */
export function compensationFlows(): Array<{ key: string; label: string; flowId: string }> {
  const contract = readSnapshot<{
    actions?: Array<{ key: string; label: string; flowId: string }>;
  }>('../flow-contract.json');
  return contract.actions ?? [];
}

interface SnapshotField {
  field: string;
  type: string;
  meta?: Record<string, unknown> | null;
  schema?: Record<string, unknown> | null;
}

interface SnapshotRelation {
  collection: string;
  field: string;
  related_collection?: string | null;
  meta?: Record<string, unknown> | null;
  schema?: { on_delete?: string | null } | null;
}

function readSnapshot<T>(file: string): T {
  return JSON.parse(fs.readFileSync(new URL(file, SNAPSHOT_DIR), 'utf8')) as T;
}

/**
 * Strip the bits of a snapshot field that are tied to the SOURCE instance:
 * `meta.id` (a row id in the source's directus_fields), `meta.group` (points at
 * a layout group we deliberately don't clone, and Directus rejects a group that
 * doesn't exist), and the resolved FK names in `schema` — the relation is
 * created separately, and passing a foreign key here fails on a fresh table.
 */
function cleanField(field: SnapshotField): SnapshotField {
  const meta = { ...(field.meta ?? {}) };
  delete meta.id;
  delete meta.group;
  const schema = field.schema ? { ...field.schema } : undefined;
  if (schema) {
    delete schema.foreign_key_table;
    delete schema.foreign_key_column;
  }
  return { field: field.field, type: field.type, meta, schema };
}

/** Layout-only aliases (tabs, groups, the button bar) and the PK are not fields we add. */
function isAddableField(field: SnapshotField): boolean {
  return field.type !== 'alias' && !field.schema?.is_primary_key;
}

export async function applyCompensation(client: Client, idempotent: Idempotent): Promise<void> {
  console.log('Compensation ops queue (schema clone):');

  if (!fs.existsSync(SNAPSHOT_DIR)) {
    // Non-fatal: an image built without the snapshots still bootstraps the CRM.
    // verify.ts is what turns this into a loud, checkable failure.
    console.log(`  ~ schema snapshots not found at ${SNAPSHOT_DIR.pathname} — skipped`);
    return;
  }

  const target = readSnapshot<{ meta?: Record<string, unknown> }>('collection.json');
  const fieldsByCollection = new Map<string, SnapshotField[]>(
    COMPENSATION_COLLECTIONS.map((collection) => [
      collection,
      readSnapshot<SnapshotField[]>(FIELD_SNAPSHOTS[collection] as string),
    ]),
  );

  const existingCollections = new Set(
    ((await client.request(readCollections() as never)) as Array<{ collection: string }>).map(
      (c) => c.collection,
    ),
  );

  for (const collection of COMPENSATION_COLLECTIONS) {
    const fields = fieldsByCollection.get(collection) as SnapshotField[];

    if (existingCollections.has(collection)) {
      console.log(`  = collection ${collection} (exists)`);
    } else {
      // Create with the primary key only; the rest are added below so the same
      // path fills in a collection that exists but is missing fields.
      const pk =
        fields.find((f) => f.schema?.is_primary_key) ?? fields.find((f) => f.field === 'id');
      if (!pk) throw new Error(`compensation snapshot for ${collection} has no primary key`);
      const pkField = cleanField(pk);
      pkField.schema = { ...(pkField.schema ?? {}), is_primary_key: true };
      const meta = { ...(collection === 'compensation_requests' ? (target.meta ?? {}) : {}) };
      delete meta.id;
      await idempotent(`collection ${collection}`, () =>
        client.request(
          createCollection({
            collection,
            meta: Object.keys(meta).length ? meta : { icon: 'receipt_long' },
            schema: { name: collection },
            fields: [pkField as never],
          }) as never,
        ),
      );
    }

    // Add only the fields that are actually absent, so a re-run reports `=` for
    // every one of them (check-idempotence.mjs fails the build on a stray `+`).
    const present = new Set(
      (
        (await client.request(readFieldsByCollection(collection) as never)) as Array<{
          field: string;
        }>
      ).map((f) => f.field),
    );
    for (const field of fields) {
      if (!isAddableField(field)) continue;
      if (present.has(field.field)) {
        console.log(`  = ${collection}.${field.field} (exists)`);
        continue;
      }
      await idempotent(`${collection}.${field.field}`, () =>
        client.request(createField(collection, cleanField(field) as never) as never),
      );
    }
  }

  const owned = new Set<string>(COMPENSATION_COLLECTIONS);
  const snapshotRelations = [
    ...readSnapshot<SnapshotRelation[]>('relations.json'),
    ...readSnapshot<SnapshotRelation[]>('dep_relations.json'),
  ].filter(
    (rel) =>
      owned.has(rel.collection) &&
      !!rel.related_collection &&
      (owned.has(rel.related_collection) || EXTERNAL_TARGETS.has(rel.related_collection)),
  );

  const existingRelations = new Set(
    (
      (await client.request(readRelations() as never)) as Array<{
        collection: string;
        field: string;
      }>
    ).map((r) => `${r.collection}.${r.field}`),
  );
  // The snapshots list some relations twice (a dependency's m2o also appears in
  // the target's file); dedupe so the second copy isn't reported as a create.
  const seen = new Set<string>();
  for (const rel of snapshotRelations) {
    const key = `${rel.collection}.${rel.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = `relation ${key} -> ${rel.related_collection as string}`;
    if (existingRelations.has(key)) {
      console.log(`  = ${label} (exists)`);
      continue;
    }
    const meta = { ...(rel.meta ?? {}) };
    delete meta.id;
    await idempotent(label, () =>
      client.request(
        createRelation({
          collection: rel.collection,
          field: rel.field,
          related_collection: rel.related_collection as string,
          meta,
          schema: { on_delete: rel.schema?.on_delete ?? 'SET NULL' },
        }) as never,
      ),
    );
  }
}
