import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STORE_NOTIFY_MAX_ATTEMPTS,
  STORE_NOTIFY_SEND_JOB,
  complaintMessage,
  runStoreNotifySend,
  saraposConfigFromEnv,
  scheduleStoreNotifySend,
  type SaraposConfig,
} from '../src/processors/store-notify-send.js';

/**
 * BRANCH NOTIFICATIONS -> SARAPOS (owner, 2026-10-29).
 *
 * Pins: off without the SARAPOS_* settings; each queued row goes to the
 * branch's SaraPOS outlet (never the Yiji restaurant id) with both headers;
 * the outcome is recorded (sent / retried / failed after the cap); a store
 * without a SaraPOS ID fails without a call; credentials refused stops the
 * run; the staging redirect sends to the test outlet and is refused on prod;
 * only recent rows are read, so an old backlog never floods the branches.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const NOW = new Date('2026-10-29T09:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn() };
const CFG: SaraposConfig = {
  baseUrl: 'https://pos.example/api',
  bearerToken: 'tok',
  secretKey: 'sec',
};

type Row = Record<string, unknown> & { id: string };

function row(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    complaint_type: 'Missing item',
    description: 'Fries were missing',
    resolution_notes: 'Apologised, coupon offered',
    order_id: '1339586',
    order_items: [
      { name: 'Pasta', qty: 2 },
      { name: 'Fries', qty: 1 },
    ],
    attempts: 0,
    store: { name: 'Dhahran Mall', code: 'LCP-002', sarapos_outlet_id: '54' },
    ...extra,
  };
}

function harness(rows: Row[], opts: { readFails?: boolean } = {}) {
  const patches: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const reads: unknown[] = [];
  const directus = {
    request: vi.fn(
      async (arg: { id?: string; payload?: Record<string, unknown>; opts?: unknown }) => {
        if (arg.payload) {
          patches.push({ id: arg.id!, payload: arg.payload });
          return {};
        }
        if (opts.readFails) throw new Error('403 forbidden field attempts');
        reads.push(arg.opts);
        return rows;
      },
    ),
  };
  return { directus: directus as never, patches, reads };
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

const OK = { status: 1, success: 1, message: 'Complaint sent to the outlet successfully' };

beforeEach(() => {
  logger.info.mockReset();
  logger.warn.mockReset();
});

describe('runStoreNotifySend', () => {
  it('does nothing at all when SaraPOS is not configured', async () => {
    const h = harness([row('n1')]);
    const fetch = vi.fn();
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: null, logger, fetch });
    expect(res.stopped).toBe('off');
    expect(fetch).not.toHaveBeenCalled();
    expect(h.directus.request).not.toHaveBeenCalled();
  });

  it("posts to the branch's SaraPOS outlet with both headers and marks it sent", async () => {
    const h = harness([row('n1')]);
    const fetch = vi.fn(async () => reply(200, OK));
    const res = await runStoreNotifySend({
      directus: h.directus,
      sarapos: CFG,
      logger,
      fetch,
      now: () => NOW,
    });
    expect(res).toMatchObject({ sent: 1, retrying: 0, failed: 0 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pos.example/api/order/complain-order');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Secret_key).toBe('sec');
    const body = JSON.parse(String(init.body));
    expect(body.outlet_id).toBe(54);
    expect(body.message_heading).toBe('Missing item - Order 1339586');
    expect(body.customer_message).toContain('Items: 2x Pasta, Fries');
    expect(h.patches).toEqual([
      {
        id: 'n1',
        payload: { status: 'sent', sent_at: NOW.toISOString(), error: null, attempts: 1 },
      },
    ]);
  });

  it('reads only queued rows from the last 24 hours, oldest first, bounded', async () => {
    const h = harness([]);
    await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, now: () => NOW });
    const opts = h.reads[0] as { filter: unknown; sort: string[]; limit: number };
    expect(opts.filter).toEqual({
      _and: [{ status: { _eq: 'queued' } }, { date_created: { _gte: '2026-10-28T09:00:00.000Z' } }],
    });
    expect(opts.sort).toEqual(['date_created']);
    expect(opts.limit).toBe(20);
  });

  it('fails a row whose store has no SaraPOS ID without calling SaraPOS', async () => {
    const h = harness([row('n1', { store: { name: 'X', sarapos_outlet_id: null } })]);
    const fetch = vi.fn();
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(h.patches[0]!.payload).toMatchObject({ status: 'failed' });
  });

  it('keeps a refused row queued for a retry, then fails it after the cap', async () => {
    const h = harness([row('n1'), row('n2', { attempts: STORE_NOTIFY_MAX_ATTEMPTS - 1 })]);
    const fetch = vi.fn(async () => reply(400, { success: false, message: 'bad outlet' }));
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(res).toMatchObject({ sent: 0, retrying: 1, failed: 1 });
    expect(h.patches[0]!.payload).toMatchObject({ status: 'queued', attempts: 1 });
    expect(h.patches[0]!.payload.error).toContain('bad outlet');
    expect(h.patches[1]!.payload).toMatchObject({
      status: 'failed',
      attempts: STORE_NOTIFY_MAX_ATTEMPTS,
    });
  });

  it('treats a 200 that says success:0 as a refusal', async () => {
    const h = harness([row('n1')]);
    const fetch = vi.fn(async () => reply(200, { success: 0, message: 'outlet closed' }));
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(res.retrying).toBe(1);
    expect(h.patches[0]!.payload.status).toBe('queued');
  });

  it('stops the run when our credentials are refused', async () => {
    const h = harness([row('n1'), row('n2')]);
    const fetch = vi.fn(async () => reply(401, { message: 'unauthorized' }));
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(res.stopped).toBe('unauthorized');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a network failure is retried, not lost', async () => {
    const h = harness([row('n1')]);
    const fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(res.retrying).toBe(1);
    expect(String(h.patches[0]!.payload.error)).toContain('unreachable');
  });

  it('staging redirect: sends to the test outlet and names the real branch', async () => {
    const h = harness([row('n1')]);
    const fetch = vi.fn(async () => reply(200, OK));
    await runStoreNotifySend({
      directus: h.directus,
      sarapos: { ...CFG, redirectOutletId: '49' },
      logger,
      fetch,
    });
    const body = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.outlet_id).toBe(49);
    expect(body.customer_message).toContain('real branch: LCP-002 Dhahran Mall (SaraPOS 54)');
  });

  it('is inert when the outbox cannot be read (fields not applied yet)', async () => {
    const h = harness([row('n1')], { readFails: true });
    const fetch = vi.fn();
    const res = await runStoreNotifySend({ directus: h.directus, sarapos: CFG, logger, fetch });
    expect(res.stopped).toBe('read-failed');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('complaintMessage', () => {
  it('never carries customer details - only order, items, complaint and action', () => {
    const m = complaintMessage(row('n1'));
    expect(m.customer_message).toBe(
      'Order: 1339586\nItems: 2x Pasta, Fries\nComplaint: Fries were missing\nAction taken: Apologised, coupon offered',
    );
  });

  it('falls back to the complaint type when the row is bare', () => {
    expect(complaintMessage({ id: 'x', complaint_type: 'Hospitality' })).toEqual({
      message_heading: 'Hospitality',
      customer_message: 'Hospitality',
    });
  });
});

describe('saraposConfigFromEnv', () => {
  const full = {
    SARAPOS_API_URL: 'https://pos.example/api/',
    SARAPOS_BEARER_TOKEN: 't',
    SARAPOS_SECRET_KEY: 's',
  };

  it('is off unless all three settings are present', () => {
    expect(saraposConfigFromEnv({})).toBeNull();
    expect(saraposConfigFromEnv({ ...full, SARAPOS_SECRET_KEY: '' })).toBeNull();
    expect(saraposConfigFromEnv(full)).toMatchObject({ baseUrl: 'https://pos.example/api' });
  });

  it('refuses a redirect on a worker pointed at production', () => {
    expect(() =>
      saraposConfigFromEnv({
        ...full,
        SARAPOS_REDIRECT_OUTLET_ID: '49',
        DIRECTUS_INTERNAL_URL: 'https://crm-api.anan.sa',
      }),
    ).toThrow(/PRODUCTION/);
    expect(
      saraposConfigFromEnv({
        ...full,
        SARAPOS_REDIRECT_OUTLET_ID: '49',
        DIRECTUS_INTERNAL_URL: 'https://crm-api-staging.anan.sa',
      })?.redirectOutletId,
    ).toBe('49');
  });
});

describe('scheduleStoreNotifySend', () => {
  it('upserts one scheduler, and 0 removes it', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleStoreNotifySend(queue as never, 60_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'store-notify-send',
      { every: 60_000 },
      expect.objectContaining({ name: STORE_NOTIFY_SEND_JOB }),
    );
    await scheduleStoreNotifySend(queue as never, 0);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('store-notify-send');
  });
});
