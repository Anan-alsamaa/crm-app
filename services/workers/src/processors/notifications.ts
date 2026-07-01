import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { NotificationJob } from '@yiji/shared-types';
import type { NotificationsRepo } from './repos.js';
import type { MailTransport } from '../mail/index.js';

/**
 * Notifications processor (T073) — fan a notification out per the recipient's
 * channel preferences (D-07). Always writes an in-app row (so the bell badge
 * shows it); only emails when the user enabled email for this type.
 *
 * The socket push to the recipient's personal room is handled by the gateway
 * via a Redis publish (workers don't talk to Socket.IO directly). Stamping
 * channel_inapp_delivered_at = now is what the gateway listens for.
 */

export interface NotifDeps {
  notifications: NotificationsRepo;
  mail: MailTransport;
  logger: Logger;
  /** Called after each in-app notification row is written so the gateway can push it. */
  onInAppCreated?: (notification: { id: string; recipient: string; type: string }) => void;
}

export async function processNotificationJob(
  job: Job<NotificationJob>,
  deps: NotifDeps,
): Promise<void> {
  const { recipientId, type, title, body, link, payload } = job.data;

  // Per-user channel preference: in_app | email | both | none. Default = both.
  const prefs = await deps.notifications.getUserPreferences(recipientId);
  const channel = prefs[type] ?? 'both';
  if (channel === 'none') {
    deps.logger.debug({ recipientId, type }, 'notification suppressed by preference');
    return;
  }

  const now = new Date().toISOString();
  const inApp = channel === 'in_app' || channel === 'both';
  const email = channel === 'email' || channel === 'both';

  const created = await deps.notifications.createNotification({
    recipient: recipientId,
    type,
    title,
    body,
    link,
    payload,
    channelInappDeliveredAt: inApp ? now : undefined,
    // Email delivery is stamped only AFTER a successful send (below), never at
    // creation — a requested email with no address, or a failed send, is not delivered.
  });
  if (inApp) deps.onInAppCreated?.({ id: created.id, recipient: recipientId, type });

  if (email) {
    // Best-effort: the durable in-app row is already written. Every step here —
    // resolving the address, the SMTP send, stamping delivery — is wrapped so it
    // can NOT throw out of the job. Otherwise BullMQ (which now retries this queue)
    // would re-run the job and re-create the in-app row (duplicate) + re-send the
    // email. With this guard, a retry only fires when createNotification itself
    // failed (no row yet), which is safe.
    try {
      // The job payload only carries the user id; skip if we can't resolve one.
      const to = await deps.notifications.getUserEmail(recipientId);
      if (!to) {
        deps.logger.warn(
          { recipientId, type },
          'email channel requested but recipient has no email; in-app row already written',
        );
      } else {
        await deps.mail.send({ to, subject: title, text: body });
        await deps.notifications.markEmailDelivered(created.id);
      }
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'email delivery failed; in-app row already written',
      );
    }
  }
}
