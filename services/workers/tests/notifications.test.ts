import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { NotificationJob } from '@yiji/shared-types';
import { processNotificationJob, type NotifDeps } from '../src/processors/notifications.js';
import type { NotificationsRepo } from '../src/processors/repos.js';
import type { MailTransport } from '../src/mail/index.js';

function makeRepo(prefs: Record<string, string>, email: string | null = 'user-1@example.com') {
  const created: Array<Record<string, unknown>> = [];
  const repo: NotificationsRepo = {
    getUserPreferences: async () => prefs,
    getUserEmail: async () => email,
    createNotification: async (input) => {
      created.push(input);
      return { id: `n-${created.length}` };
    },
    markEmailDelivered: async (id) => {
      // model the real repo: the row is stamped delivered only after a real send
      const idx = Number(id.replace('n-', '')) - 1;
      if (created[idx]) created[idx]!.channelEmailDeliveredAt = new Date().toISOString();
    },
  };
  return { repo, created };
}

function makeMail() {
  const sent: Array<{ to: string; subject: string }> = [];
  const mail: MailTransport = {
    send: async (m) => {
      sent.push(m);
    },
  };
  return { mail, sent };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;
const JOB = {
  data: {
    recipientId: 'user-1',
    type: 'sla_warning',
    title: 'SLA',
    body: '...',
    link: '/x',
  } as NotificationJob,
} as Job<NotificationJob>;

describe('processNotificationJob (T068)', () => {
  it('channel "both": writes in-app row with both delivery timestamps + sends email', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'both' });
    const { mail, sent } = makeMail();
    const pushed: Array<unknown> = [];
    const deps: NotifDeps = {
      notifications: repo,
      mail,
      logger,
      onInAppCreated: (n) => pushed.push(n),
    };
    await processNotificationJob(JOB, deps);
    expect(created).toHaveLength(1);
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    expect(created[0]!.channelEmailDeliveredAt).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it('channel "in_app": writes in-app row + no email', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'in_app' });
    const { mail, sent } = makeMail();
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    expect(created[0]!.channelEmailDeliveredAt).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('channel "email": skips in-app stamp + sends email to the resolved address', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'email' });
    const { mail, sent } = makeMail();
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created[0]!.channelInappDeliveredAt).toBeUndefined();
    expect(created[0]!.channelEmailDeliveredAt).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('user-1@example.com');
  });

  it('email channel but recipient has no email: no send, in-app row still written', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'both' }, null);
    const { mail, sent } = makeMail();
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created).toHaveLength(1);
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    // BUG FIX: no address ⇒ NOT marked delivered (was stamped delivered at creation).
    expect(created[0]!.channelEmailDeliveredAt).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('channel "none": suppresses the entire notification', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'none' });
    const { mail, sent } = makeMail();
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('defaults to "both" when no preference is recorded for the type', async () => {
    const { repo, created } = makeRepo({});
    const { mail, sent } = makeMail();
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it('email failure does NOT lose the in-app row', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'both' });
    const mail: MailTransport = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    await processNotificationJob(JOB, { notifications: repo, mail, logger });
    expect(created).toHaveLength(1);
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    // BUG FIX: a failed send must NOT be marked delivered.
    expect(created[0]!.channelEmailDeliveredAt).toBeUndefined();
  });

  it('email-lookup failure is swallowed so a retry cannot duplicate (retry-safe)', async () => {
    const { repo, created } = makeRepo({ sla_warning: 'both' });
    // Resolving the address blips (e.g. Directus briefly down). With retries now
    // enabled on the notifications queue this must NOT throw — otherwise the retry
    // would re-create the in-app row + re-send. The row is still written once.
    repo.getUserEmail = async () => {
      throw new Error('directus down');
    };
    const { mail } = makeMail();
    await expect(
      processNotificationJob(JOB, { notifications: repo, mail, logger }),
    ).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect(created[0]!.channelInappDeliveredAt).toBeTruthy();
    expect(created[0]!.channelEmailDeliveredAt).toBeUndefined();
  });
});
