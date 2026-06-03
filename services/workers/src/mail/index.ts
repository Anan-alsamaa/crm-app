import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { WorkersConfig } from '../config.js';

/**
 * MailTransport interface (spec: pluggable email transport).
 * SMTP implementation for prod/staging; a no-op dev implementation that logs
 * instead of sending when SMTP is not configured.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;
  constructor(
    private readonly config: WorkersConfig,
    private readonly logger: Logger,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
  }
  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.config.SMTP_FROM, ...message });
    this.logger.debug({ to: message.to, subject: message.subject }, 'email sent');
  }
}

class NoopMailTransport implements MailTransport {
  constructor(private readonly logger: Logger) {}
  async send(message: MailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject },
      'email (dev no-op transport — not sent)',
    );
  }
}

/** Select the transport based on configuration. */
export function createMailTransport(config: WorkersConfig, logger: Logger): MailTransport {
  return config.SMTP_HOST ? new SmtpMailTransport(config, logger) : new NoopMailTransport(logger);
}
