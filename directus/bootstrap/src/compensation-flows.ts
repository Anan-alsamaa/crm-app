/**
 * Compensation workflow flows — the "buttons" on a compensation request.
 *
 * Each action in the agent portal is a Directus MANUAL flow triggered by a
 * FIXED id (directus/compensation-clone/flow-contract.json). Provisioning the
 * schema alone leaves the queue readable but every button dead, so a fresh
 * production Directus needs these too.
 *
 * These are the REAL production pipelines, replayed from the read-only
 * snapshots in `compensation-clone/schema/prod-flow-*.json`. They are NOT the
 * offline stand-ins from `standin-flows.mjs` — those simulate the transitions
 * and must never reach production.
 *
 * THE CREDENTIAL IS NOT IN THE SNAPSHOT. `CR->Generate Coupon` POSTs to the
 * Yiji AddCoupon API, and the extraction redacted its bearer token
 * (`Bearer <REDACTED>`) rather than committing a live secret. It is injected
 * here from `YIJI_API_KEY` at provision time. Without that variable the coupon
 * flow is SKIPPED entirely — creating it with a placeholder would produce a
 * button that looks wired and fails on click against a real billing endpoint.
 *
 * Everything here is create-only: a flow whose id already exists is left
 * completely alone, so re-running never edits a flow an operator has since
 * tuned in the Directus UI.
 */
import { createFlow, createOperation, readFlows, updateFlow, updateOperation } from '@directus/sdk';
import fs from 'node:fs';

type Client = { request: (options: never) => Promise<unknown> };
type Idempotent = (label: string, fn: () => Promise<unknown>) => Promise<void>;

const SNAPSHOT_DIR = new URL('../../compensation-clone/schema/', import.meta.url);

/** Snapshot file per action. Order is cosmetic — flows are independent. */
const FLOW_FILES = [
  'prod-flow-acknowledge.json',
  'prod-flow-calculate.json',
  'prod-flow-generate_coupon.json',
  'prod-flow-assign_coupon.json',
  'prod-flow-approve.json',
  'prod-flow-reject.json',
  'prod-flow-refund.json',
] as const;

/** Placeholder left by the read-only extraction in place of the live token. */
const REDACTED = '<REDACTED>';

interface SnapshotOperation {
  id: string;
  key: string;
  type: string;
  name?: string | null;
  position_x?: number;
  position_y?: number;
  options?: Record<string, unknown> | null;
  resolve?: string | null;
  reject?: string | null;
}

interface SnapshotFlow {
  flow: {
    id: string;
    name: string;
    icon?: string | null;
    color?: string | null;
    description?: string | null;
    status?: string;
    trigger?: string;
    accountability?: string | null;
    options?: Record<string, unknown> | null;
    operation?: string | null;
  };
  operations: SnapshotOperation[];
}

/** Does this operation carry the redacted Yiji credential? */
function needsYijiToken(op: SnapshotOperation): boolean {
  return JSON.stringify(op.options ?? {}).includes(REDACTED);
}

/**
 * Swap the redacted bearer for the real one. Only ever touches the exact
 * placeholder string, so an operation that has no secret is passed through
 * byte-for-byte.
 */
function injectToken(
  options: Record<string, unknown> | null | undefined,
  token: string,
): Record<string, unknown> {
  const raw = JSON.stringify(options ?? {});
  return JSON.parse(raw.split(REDACTED).join(token)) as Record<string, unknown>;
}

export async function applyCompensationFlows(
  client: Client,
  idempotent: Idempotent,
): Promise<void> {
  console.log('Compensation workflow flows:');

  if (!fs.existsSync(SNAPSHOT_DIR)) {
    console.log('  ~ flow snapshots not found — skipped');
    return;
  }

  const yijiToken = process.env.YIJI_API_KEY?.trim();

  // Existing flows are identified by id: the portal triggers by id, so an id
  // that is already present is already wired, whatever it is named.
  const existing = new Set(
    (
      (await client.request(readFlows({ limit: -1, fields: ['id'] }) as never)) as Array<{
        id: string;
      }>
    ).map((f) => f.id),
  );

  for (const file of FLOW_FILES) {
    const snap = JSON.parse(fs.readFileSync(new URL(file, SNAPSHOT_DIR), 'utf8')) as SnapshotFlow;
    const { flow, operations } = snap;

    if (existing.has(flow.id)) {
      console.log(`  = flow ${flow.name} (exists)`);
      continue;
    }

    const secretOps = operations.filter(needsYijiToken);
    if (secretOps.length && !yijiToken) {
      // Loud, and it names the fix. A silently-missing button is the failure
      // mode this whole bootstrap exists to prevent.
      console.warn(
        `  ! flow ${flow.name} SKIPPED — it calls the Yiji API and YIJI_API_KEY is not set. ` +
          `Set YIJI_API_KEY and re-run; until then this button will 404 for ops.`,
      );
      continue;
    }

    // 1. The flow itself, WITHOUT `operation`: that points at the first
    //    operation, which cannot exist yet. Wired up in step 3.
    await idempotent(`flow ${flow.name}`, () =>
      client.request(
        createFlow({
          id: flow.id,
          name: flow.name,
          icon: flow.icon ?? null,
          color: flow.color ?? null,
          description: flow.description ?? null,
          status: flow.status ?? 'active',
          trigger: flow.trigger ?? 'manual',
          accountability: flow.accountability ?? 'all',
          options: flow.options ?? {},
        }) as never,
      ),
    );

    // 2. Operations, ids preserved so resolve/reject wiring stays valid. They
    //    reference each other, so create them all before wiring (below): a
    //    resolve target must exist by the time Directus validates it.
    for (const op of operations) {
      await idempotent(`  op ${flow.name}/${op.key}`, () =>
        client.request(
          createOperation({
            id: op.id,
            flow: flow.id,
            key: op.key,
            type: op.type,
            name: op.name ?? null,
            position_x: op.position_x ?? 19,
            position_y: op.position_y ?? 1,
            options: needsYijiToken(op)
              ? injectToken(op.options, yijiToken as string)
              : (op.options ?? {}),
          }) as never,
        ),
      );
    }

    // 3. Wire the graph now that every node exists.
    for (const op of operations) {
      if (!op.resolve && !op.reject) continue;
      await idempotent(`  wire ${flow.name}/${op.key}`, () =>
        client.request(
          updateOperation(op.id, {
            resolve: op.resolve ?? null,
            reject: op.reject ?? null,
          } as never) as never,
        ),
      );
    }

    // 4. Point the flow at its entry operation.
    if (flow.operation) {
      await idempotent(`  entry ${flow.name}`, () =>
        client.request(updateFlow(flow.id, { operation: flow.operation } as never) as never),
      );
    }
  }

  if (!yijiToken) {
    console.log(
      '  ~ YIJI_API_KEY not set: the Generate Coupon flow was not provisioned (see above).',
    );
  }
}
