import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BRANCH_MESSAGE_KIND,
  BRANCH_MESSAGE_MAX,
  BRANCH_MESSAGE_PER_HOUR,
  branchMessageHeading,
  branchMessageProblem,
  looksLikePhoneNumber,
} from '../src/branch-message.js';

/**
 * A CUSTOM MESSAGE TO A BRANCH (owner, 26 Nov 2026): agents write to a
 * branch's SaraPOS printer with no ticket. These tests load the real
 * app-roles-sync extension with a fake database and call the guard it puts on
 * store_notifications.items.create.
 */

const EXT = fileURLToPath(
  new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url),
);
const SYNC = readFileSync(EXT, 'utf8');

type Hook = (payload: unknown, meta: unknown, context: unknown) => Promise<unknown>;
const filters = new Map<string, Hook>();

/* The fake database: app_roles by directus_role, stores by id, and a count of
   recent custom messages per store. */
let roles: Record<string, { name: string; privileges: string | null }> = {};
let stores: Record<
  string,
  { id: string; sarapos_outlet_id: string | null; vendor?: string | null }
> = {};
let recentCount = 0;

function fakeDatabase(table: string) {
  const where: Record<string, unknown> = {};
  const q = {
    where(cond: Record<string, unknown> | string) {
      if (typeof cond === 'object') Object.assign(where, cond);
      return q;
    },
    count() {
      return q;
    },
    async first() {
      if (table === 'app_roles') return roles[String(where.directus_role)];
      if (table === 'stores') return stores[String(where.id)];
      if (table === 'store_notifications') return { n: String(recentCount) };
      return undefined;
    },
  };
  return q;
}

beforeAll(async () => {
  const mod = (await import(pathToFileURL(EXT).href)) as {
    default: (hooks: unknown, ctx: unknown) => void;
  };
  mod.default(
    { filter: (event: string, fn: Hook) => filters.set(event, fn), action: () => {} },
    {
      services: { RolesService: class {}, PoliciesService: class {}, PermissionsService: class {} },
      database: fakeDatabase,
      getSchema: async () => ({}),
      logger: { info: () => {}, warn: () => {} },
    },
  );
});

beforeEach(() => {
  roles = {
    'r-agent': { name: 'WeCare Agent', privileges: null },
    'r-agent-off': {
      name: 'WeCare Agent',
      privileges: JSON.stringify({ send_branch_messages: false }),
    },
    'r-ceo': { name: 'CEO', privileges: JSON.stringify({ view_dashboard: true }) },
    'r-ceo-on': { name: 'CEO', privileges: JSON.stringify({ send_branch_messages: true }) },
  };
  stores = {
    lab: { id: 'lab', sarapos_outlet_id: '2', vendor: 'v-anan' },
    noPos: { id: 'noPos', sarapos_outlet_id: null },
  };
  recentCount = 0;
});

const as = (role: string | null, admin = false) => ({
  accountability: role === null ? null : { user: 'u1', role, admin },
});
const send = (payload: unknown, ctx: unknown) =>
  filters.get('store_notifications.items.create')!(payload, {}, ctx);
const custom = (extra: Record<string, unknown> = {}) => ({
  kind: 'custom',
  store: 'lab',
  description: 'Please call WeCare about order 1350658.',
  ...extra,
});

describe('the server guard on custom branch messages', () => {
  it('leaves a ticket notification exactly as it was', async () => {
    const ticketRow = {
      ticket: 't1',
      store: 'lab',
      complaint_type: 'Late order',
      description: 'x',
    };
    await expect(send(ticketRow, as('r-ceo'))).resolves.toBe(ticketRow);
  });

  it('a WeCare Agent may send; the row is rebuilt from branch, text and order only', async () => {
    const out = await send(
      custom({
        order_id: ' 1350658 ',
        ticket: 't-sneaky',
        complaint_type: 'Late order',
        status: 'sent',
        attempts: 9,
        resolution_notes: 'customer 0551234567',
      }),
      as('r-agent'),
    );
    expect(out).toEqual({
      kind: 'custom',
      store: 'lab',
      description: 'Please call WeCare about order 1350658.',
      order_id: '1350658',
      status: 'queued',
      attempts: 0,
      vendor: 'v-anan',
    });
  });

  it('a role without the privilege is refused, by default or by an unticked switch', async () => {
    await expect(send(custom(), as('r-ceo'))).rejects.toMatchObject({ status: 403 });
    await expect(send(custom(), as('r-agent-off'))).rejects.toMatchObject({ status: 403 });
  });

  it('a role the Administrator ticked may send', async () => {
    await expect(send(custom(), as('r-ceo-on'))).resolves.toMatchObject({ status: 'queued' });
  });

  it('the Administrator holds it without a stored tick', async () => {
    await expect(send(custom(), as('r-none', true))).resolves.toMatchObject({ kind: 'custom' });
  });

  it('refuses an empty or too-long message', async () => {
    await expect(send(custom({ description: '   ' }), as('r-agent'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      send(custom({ description: 'x'.repeat(BRANCH_MESSAGE_MAX + 1) }), as('r-agent')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      send(custom({ description: 'x'.repeat(BRANCH_MESSAGE_MAX) }), as('r-agent')),
    ).resolves.toBeTruthy();
  });

  it('refuses no branch, an unknown branch, and a branch without SaraPOS', async () => {
    await expect(send(custom({ store: null }), as('r-agent'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(send(custom({ store: 'nope' }), as('r-agent'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(send(custom({ store: 'noPos' }), as('r-agent'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it(`allows ${BRANCH_MESSAGE_PER_HOUR} messages per branch per hour, then refuses`, async () => {
    recentCount = BRANCH_MESSAGE_PER_HOUR - 1;
    await expect(send(custom(), as('r-agent'))).resolves.toBeTruthy();
    recentCount = BRANCH_MESSAGE_PER_HOUR;
    await expect(send(custom(), as('r-agent'))).rejects.toMatchObject({ status: 400 });
  });

  it('the extension uses the same limits as the portal', () => {
    expect(SYNC).toContain(`const BRANCH_MESSAGE_KIND = '${BRANCH_MESSAGE_KIND}';`);
    expect(SYNC).toContain(`const BRANCH_MESSAGE_MAX = ${BRANCH_MESSAGE_MAX};`);
    expect(SYNC).toContain(`const BRANCH_MESSAGE_PER_HOUR = ${BRANCH_MESSAGE_PER_HOUR};`);
  });
});

describe('what the branch prints, and the form checks', () => {
  it('heading is "WeCare message", with the order when there is one', () => {
    expect(branchMessageHeading()).toBe('WeCare message');
    expect(branchMessageHeading('  ')).toBe('WeCare message');
    expect(branchMessageHeading(' 1350658 ')).toBe('WeCare message - Order 1350658');
  });

  it('spots a Saudi mobile in the forms people type, and not an order number', () => {
    for (const t of [
      'call 0551234567',
      'call 055 123 4567',
      'call +966 55 123 4567',
      'call 00966551234567',
      'رقم العميل 0551234567',
    ]) {
      expect(looksLikePhoneNumber(t)).toBe(true);
    }
    for (const t of ['order 1350658', 'please call WeCare', 'table 12, 3 items']) {
      expect(looksLikePhoneNumber(t)).toBe(false);
    }
  });

  it('says why a message cannot be sent', () => {
    expect(branchMessageProblem('')).toBe('empty');
    expect(branchMessageProblem('x'.repeat(BRANCH_MESSAGE_MAX + 1))).toBe('too_long');
    expect(branchMessageProblem('ok')).toBeNull();
  });
});
