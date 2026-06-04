import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  YIJI_JWT_SECRET: 'secret',
  SVC_GATEWAY_TOKEN: 'tok',
};

describe('loadConfig (socket-gateway)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Start from a clean slate of the keys the schema reads.
    for (const k of [
      'PORT',
      'DIRECTUS_INTERNAL_URL',
      'REDIS_URL',
      'REDIS_ENABLED',
      'YIJI_JWT_SECRET',
      'SVC_GATEWAY_TOKEN',
      'CORS_ORIGIN',
      'LOG_LEVEL',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('applies defaults when only required vars are set', () => {
    Object.assign(process.env, REQUIRED);
    const cfg = loadConfig();
    expect(cfg.PORT).toBe(8080);
    expect(cfg.REDIS_ENABLED).toBe(true);
    expect(cfg.CORS_ORIGIN).toBe('*');
    expect(cfg.DIRECTUS_INTERNAL_URL).toMatch(/^http/);
  });

  it('coerces PORT and REDIS_ENABLED from strings', () => {
    Object.assign(process.env, REQUIRED, { PORT: '9090', REDIS_ENABLED: 'false' });
    const cfg = loadConfig();
    expect(cfg.PORT).toBe(9090);
    expect(cfg.REDIS_ENABLED).toBe(false);
  });

  it('throws when a required secret is missing', () => {
    Object.assign(process.env, { SVC_GATEWAY_TOKEN: 'tok' }); // no YIJI_JWT_SECRET
    expect(() => loadConfig()).toThrow();
  });
});
