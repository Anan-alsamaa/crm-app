import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the transporter nodemailer.createTransport returns so we can assert
// the SMTP path sends mail; the no-op path must not construct one. Hoisted so
// the mocks are initialised before the hoisted vi.mock factory runs.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: 'x' }));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

import { createMailTransport } from '../src/mail/index.js';
import type { WorkersConfig } from '../src/config.js';

const silentLogger = {
  info: vi.fn(),
  warn: () => undefined,
  error: () => undefined,
  debug: vi.fn(),
} as never;

function config(over: Partial<WorkersConfig>): WorkersConfig {
  return {
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: 'noreply@yiji.test',
    ...over,
  } as WorkersConfig;
}

beforeEach(() => vi.clearAllMocks());

describe('createMailTransport', () => {
  it('returns a no-op transport when SMTP_HOST is unset (no transporter built)', async () => {
    const t = createMailTransport(config({ SMTP_HOST: '' }), silentLogger);
    await t.send({ to: 'a@b.com', subject: 'hi', text: 'body' });
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(silentLogger.info).toHaveBeenCalled();
  });

  it('returns an SMTP transport when SMTP_HOST is set and sends mail with a from address', async () => {
    const t = createMailTransport(
      config({ SMTP_HOST: 'smtp.test', SMTP_PORT: 465, SMTP_USER: 'u', SMTP_PASSWORD: 'p' }),
      silentLogger,
    );
    await t.send({ to: 'a@b.com', subject: 'hi', text: 'body' });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.test', port: 465, secure: true }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'noreply@yiji.test', to: 'a@b.com', subject: 'hi' }),
    );
  });

  it('uses an undefined auth when no SMTP_USER is set', async () => {
    createMailTransport(config({ SMTP_HOST: 'smtp.test', SMTP_USER: '' }), silentLogger);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });
});
