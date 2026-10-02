import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job } from 'bullmq';
import type { CustomerPushJob } from '@yiji/shared-types';
import {
  processCustomerPushJob,
  isTerminalRefusal,
  refusalReason,
} from '../src/processors/customer-push.js';

/**
 * A PERMANENT REFUSAL IS AN ANSWER, NOT A FAILURE.
 *
 * Measured on production before any of this was written: 222 pushes delivered
 * over 14 days against 126 failing JOBS producing 630 log lines — because a
 * refusal Yiji will repeat for ever was thrown, and BullMQ retried it five
 * times each. The reason was invisible the whole time: `YijiRefusedError`
 * keeps Yiji's words on `.body` and the log printed only `.message`, which is
 * always `admin <path> refused (400)`.
 *
 * Probed live against a deliberately NON-EXISTENT number, so no real handset
 * was touched:
 *
 *     {"result":2,"exceptionMessage":"Customer has no registered FCM device token."}
 *
 * That is a fact about a person — no Yiji app, or notifications denied — and
 * about a third of our customers are in it.
 */

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const NOTIFY_URL =
  'https://notificationsystems.yiji-app.com/api/NotificationData/SendCrmNotification';

const job = (over: Partial<CustomerPushJob> = {}) =>
  ({
    data: {
      conversationId: 'c-1',
      phone: '0512345678',
      externalCustomerId: 'yiji-7',
      preview: 'any update on this?',
      sentAt: '2026-10-02T09:00:00.000Z',
      ...over,
    },
  }) as Job<CustomerPushJob>;

/** Yiji's refusal, in the shape `YijiRefusedError` really produces. */
const refused = (exceptionMessage: string, status = 400) =>
  Object.assign(new Error(`admin ${NOTIFY_URL} refused (${status})`), {
    name: 'YijiRefusedError',
    status,
    body: { result: 2, exceptionMessage, errorCode: null },
  });

const deps = (over: Record<string, unknown> = {}) => ({
  logger,
  yijiNotifyUrl: NOTIFY_URL,
  yijiApiKey: '',
  postNotification: vi.fn().mockResolvedValue({ result: 1 }),
  ...over,
});

describe('reading the refusal', () => {
  /* THE REGRESSION THAT HID EVERYTHING: the cause is on `.body`, and only
     `.message` was ever logged. */
  it('prefers Yiji’s exceptionMessage over the generic message', () => {
    expect(refusalReason(refused('Customer has no registered FCM device token.'))).toBe(
      'Customer has no registered FCM device token.',
    );
  });

  it('falls back to the message when there is no body', () => {
    expect(refusalReason(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('is null when there is nothing to read', () => {
    expect(refusalReason({})).toBeNull();
    expect(refusalReason(undefined)).toBeNull();
  });
});

describe('classifying a refusal', () => {
  it.each([
    'Customer has no registered FCM device token.',
    'customer has no registered fcm device token',
    'Customer not found.',
    'Either UserId or PhoneNumber must be provided.',
  ])('treats %j as terminal', (msg) => {
    expect(isTerminalRefusal(refused(msg))).toBe(true);
  });

  /*
   * OUR OWN BUGS MUST STILL RETRY. A 400 is also how a malformed payload
   * fails — a bad brand id, a missing tenant — and a redeploy between attempts
   * can fix that. Calling every 400 terminal would hide our faults as
   * "customer unreachable".
   */
  it('does not treat an unrecognised 400 as terminal', () => {
    expect(
      isTerminalRefusal(refused('BrandId is required to resolve the Firebase credential')),
    ).toBe(false);
  });

  /* A sick upstream is exactly what retries are for. */
  it('never treats a 5xx or a timeout as terminal', () => {
    expect(isTerminalRefusal(refused('Customer not found.', 503))).toBe(false);
    expect(isTerminalRefusal(new Error('timed out after 10000ms'))).toBe(false);
  });
});

describe('a push to a handset with no token', () => {
  it('reports unreachable instead of throwing', async () => {
    const postNotification = vi
      .fn()
      .mockRejectedValue(refused('Customer has no registered FCM device token.'));
    const markUnreachable = vi.fn().mockResolvedValue(undefined);

    const outcome = await processCustomerPushJob(
      job(),
      deps({ postNotification, markUnreachable }) as never,
    );

    expect(outcome).toBe('unreachable');
    /* ONE attempt. The whole point: five calls to Yiji per unreachable
       customer bought nothing. */
    expect(postNotification).toHaveBeenCalledTimes(1);
  });

  /* A LOG LINE CANNOT REACH AN AGENT. The agent is waiting to learn whether
     their message landed, so the verdict goes on the conversation. */
  it('records the reason on the conversation, verbatim', async () => {
    const markUnreachable = vi.fn().mockResolvedValue(undefined);
    await processCustomerPushJob(
      job(),
      deps({
        postNotification: vi
          .fn()
          .mockRejectedValue(refused('Customer has no registered FCM device token.')),
        markUnreachable,
      }) as never,
    );
    expect(markUnreachable).toHaveBeenCalledWith(
      'c-1',
      'Customer has no registered FCM device token.',
    );
  });

  /* Losing the marker costs a hint; throwing would resurrect the retry storm
     this change exists to remove. */
  it('still reports unreachable when the marker cannot be written', async () => {
    const outcome = await processCustomerPushJob(
      job(),
      deps({
        postNotification: vi.fn().mockRejectedValue(refused('Customer not found.')),
        markUnreachable: vi.fn().mockRejectedValue(new Error('directus down')),
      }) as never,
    );
    expect(outcome).toBe('unreachable');
  });

  /* Degrades to the old behaviour MINUS the retry storm when the dependency
     is absent, rather than crashing on an optional call. */
  it('works without a marker at all', async () => {
    const outcome = await processCustomerPushJob(
      job(),
      deps({
        postNotification: vi.fn().mockRejectedValue(refused('Customer not found.')),
        markUnreachable: undefined,
      }) as never,
    );
    expect(outcome).toBe('unreachable');
  });
});

describe('a refusal we do not recognise', () => {
  /*
   * Must keep its retries: this is how a real fault of OURS surfaces.
   *
   * Asserted on the REJECTED ERROR ITSELF, not on its message. A
   * `YijiRefusedError`'s message is only ever `admin <path> refused (400)` —
   * the reason lives on `.body`, which is the entire gap this change exists to
   * close. Matching the message would be asserting the very thing that made
   * 630 production failures unreadable.
   */
  it('is rethrown so BullMQ retries it', async () => {
    const err = refused('BrandId is required');
    await expect(
      processCustomerPushJob(
        job(),
        deps({ postNotification: vi.fn().mockRejectedValue(err) }) as never,
      ),
    ).rejects.toBe(err);
  });
});

describe('a push that succeeds', () => {
  /*
   * THE CONDITION IS NOT PERMANENT FOR THE PERSON. They install the app, or
   * turn notifications back on. A stale warning would send agents to WhatsApp
   * for a customer whose phone now rings perfectly well.
   */
  it('clears any earlier unreachable verdict', async () => {
    const markUnreachable = vi.fn().mockResolvedValue(undefined);
    const outcome = await processCustomerPushJob(job(), deps({ markUnreachable }) as never);
    expect(outcome).toBe('delivered');
    expect(markUnreachable).toHaveBeenCalledWith('c-1', null);
  });

  it('is not failed by a marker that cannot be cleared', async () => {
    const outcome = await processCustomerPushJob(
      job(),
      deps({ markUnreachable: vi.fn().mockRejectedValue(new Error('nope')) }) as never,
    );
    expect(outcome).toBe('delivered');
  });
});

/**
 * THE LOG MUST CARRY THE REASON.
 *
 * Asserted against the source: the failed-job handler is wired to live BullMQ
 * workers and a Redis connection, and mocking those to observe one log field
 * would be testing the mocks. What matters is that `.body` is read at all —
 * dropping it is what made 630 failures unreadable.
 */
/* Resolved from THIS FILE, not `process.cwd()`: vitest runs from the repo
   root here and from the package in other setups, and a cwd-relative path
   makes the suite pass or fail depending on where it was invoked. */
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

describe('the worker failure log', () => {
  const INDEX = read('src/index.ts');

  it('logs the upstream body, not only the message', () => {
    expect(INDEX).toMatch(/body\?: unknown/);
    expect(INDEX).toContain('upstream');
  });

  /* An absent body must not add a null key to every unrelated queue's
     failures. */
  it('omits the field when there is no body', () => {
    expect(INDEX).toMatch(/upstream === undefined \|\| upstream === null/);
  });
});

/**
 * AND THE FIRST-RESPONSE SWEEP MUST NOT SEE AN OUTBOUND CHAT.
 *
 * A chat the agent opened has only our message in it, so `first_responded_at`
 * stays null for its whole life. Without this filter the sweep would set a
 * clock, let it expire, and record a BREACH against the agent who made the
 * first move — every outbound chat arriving pre-broken.
 */
describe('the unanswered-conversations filter', () => {
  const REPOS = read('src/processors/directus-repos.ts');

  it('excludes agent-initiated chats', () => {
    expect(REPOS).toMatch(/initiated_by: \{ _neq: 'agent' \}/);
  });

  /*
   * `_neq`, NOT `_eq: 'customer'`. Every conversation that existed before the
   * field did has it NULL, and `_eq` would drop all of them out of the sweep —
   * a filter that matches nothing, reading as a clean zero.
   */
  it('does not use _eq, which would drop every pre-existing row', () => {
    expect(REPOS).not.toMatch(/initiated_by: \{ _eq: 'customer' \}/);
  });
});
