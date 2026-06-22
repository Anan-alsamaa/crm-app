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

const STRONG_SECRET = 'a'.repeat(48);
const REAL_TOKEN = 'directus_static_token_value';

const base = {
  YIJI_JWT_SECRET: STRONG_SECRET,
  SVC_GATEWAY_TOKEN: REAL_TOKEN,
  CORS_ORIGIN: 'https://agent.example.com',
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    'NODE_ENV',
    'CORS_ORIGIN',
    'WIDGET_CORS_ORIGIN',
    'REDIS_ENABLED',
    'YIJI_JWT_SECRET',
    'SVC_GATEWAY_TOKEN',
  ];
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('socket-gateway config prod guards', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('accepts a well-formed production config', () => {
    withEnv({ NODE_ENV: 'production', ...base }, () => {
      const cfg = loadConfig();
      expect(cfg.NODE_ENV).toBe('production');
      expect(cfg.CORS_ORIGIN).toBe('https://agent.example.com');
    });
  });

  it('rejects wildcard CORS in production', () => {
    withEnv({ NODE_ENV: 'production', ...base, CORS_ORIGIN: '*' }, () => {
      expect(() => loadConfig()).toThrow(/CORS_ORIGIN/);
    });
  });

  it('allows wildcard WIDGET_CORS_ORIGIN in production (widget embeds anywhere)', () => {
    withEnv({ NODE_ENV: 'production', ...base, WIDGET_CORS_ORIGIN: '*' }, () => {
      const cfg = loadConfig();
      expect(cfg.WIDGET_CORS_ORIGIN).toBe('*'); // customer socket: JWT-gated, origin-open
      expect(cfg.CORS_ORIGIN).toBe('https://agent.example.com'); // admin/AI: still strict
    });
  });

  it('rejects placeholder service token in production', () => {
    withEnv(
      { NODE_ENV: 'production', ...base, SVC_GATEWAY_TOKEN: 'replace-with-gateway-token' },
      () => {
        expect(() => loadConfig()).toThrow(/SVC_GATEWAY_TOKEN/);
      },
    );
  });

  it('rejects a weak JWT secret in production', () => {
    withEnv({ NODE_ENV: 'production', ...base, YIJI_JWT_SECRET: 'short' }, () => {
      expect(() => loadConfig()).toThrow(/YIJI_JWT_SECRET/);
    });
  });

  it('rejects in-memory mode (REDIS_ENABLED=false) in production', () => {
    withEnv({ NODE_ENV: 'production', ...base, REDIS_ENABLED: 'false' }, () => {
      expect(() => loadConfig()).toThrow(/REDIS_ENABLED/);
    });
  });

  it('allows the same weak values in development', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        CORS_ORIGIN: '*',
        YIJI_JWT_SECRET: 'short',
        SVC_GATEWAY_TOKEN: 'replace-with-gateway-token',
        REDIS_ENABLED: 'false',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.CORS_ORIGIN).toBe('*');
        expect(cfg.REDIS_ENABLED).toBe(false);
      },
    );
  });
});
