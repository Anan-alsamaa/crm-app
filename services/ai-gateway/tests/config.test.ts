import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

/** A config that satisfies every production guard except the one under test. */
const PROD = {
  NODE_ENV: 'production',
  SVC_AI_TOKEN: 'real-service-token',
  CORS_ORIGIN: 'https://agent.example.com',
  YIJI_API_URL: 'https://admin.example.com',
};

describe('loadConfig (ai-gateway)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of [
      'NODE_ENV',
      'SVC_AI_TOKEN',
      'CORS_ORIGIN',
      'YIJI_API_URL',
      'YIJI_API_KEY',
      'GEMINI_API_KEY',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts a fully-configured production env', () => {
    Object.assign(process.env, PROD);
    const cfg = loadConfig();
    expect(cfg.YIJI_API_URL).toBe('https://admin.example.com');
  });

  // An empty YIJI_API_URL makes createYijiClient fall back to MockYijiClient,
  // which would serve demo fixtures to real agents. Production must not boot.
  it('refuses to boot in production when YIJI_API_URL is empty (mock fallback)', () => {
    Object.assign(process.env, { ...PROD, YIJI_API_URL: '' });
    expect(() => loadConfig()).toThrow(/YIJI_API_URL/);
  });

  it('refuses to boot in production when YIJI_API_URL is only whitespace', () => {
    Object.assign(process.env, { ...PROD, YIJI_API_URL: '   ' });
    expect(() => loadConfig()).toThrow(/YIJI_API_URL/);
  });

  // Dev/test still rely on the mock client (CI runs E2E with no Yiji keys), so
  // the guard must be production-only.
  it('still allows the mock client outside production', () => {
    Object.assign(process.env, { ...PROD, NODE_ENV: 'development', YIJI_API_URL: '' });
    const cfg = loadConfig();
    expect(cfg.YIJI_API_URL).toBe('');
  });
});
