import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isClusterUrl } from '@yiji/shared-config/redis';
import { loadConfig } from '../src/config.js';

/**
 * Regression guards for two multi-instance bugs that are INVISIBLE at one task
 * and only appear once the service scales to two — the worst failure shape,
 * because every single-instance test passes.
 *
 *   1. The Socket.IO Redis adapter was built with `new Redis(url)`. Against a
 *      cluster-mode ElastiCache `clustercfg.` endpoint that client cannot follow
 *      MOVED redirects, so cross-instance fanout dies and agents on different
 *      instances stop seeing each other's messages.
 *
 *   2. Socket.IO's default transport order starts with HTTP long-polling, whose
 *      handshake spans several requests. Behind a load balancer without sticky
 *      sessions those land on different instances → "Session ID unknown".
 *
 * These assert on the SOURCE for (1) because constructing a real cluster client
 * needs a real cluster; the point is that the wrong constructor cannot come back.
 */
const INDEX_SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('multi-instance scaling guards', () => {
  describe('Redis adapter uses the cluster-aware factory', () => {
    it('builds its pub/sub clients with createRedis, not new Redis', () => {
      expect(INDEX_SRC).toContain('createRedis(config.REDIS_URL');
      // Match the CONSTRUCTION only. A bare /new Redis\(/ also hits the comment
      // that explains why this constructor is wrong, which would fail forever.
      const code = INDEX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/new Redis\s*\(/);
    });

    it('creates two independent clients rather than duplicating one', () => {
      // Cluster#duplicate does not carry the dnsLookup override the factory
      // installs for ElastiCache's private node addresses.
      expect(INDEX_SRC).not.toContain('pubClient.duplicate()');
      const calls = INDEX_SRC.match(/createRedis\(config\.REDIS_URL/g) ?? [];
      expect(calls.length).toBe(2);
    });

    it('detects a cluster endpoint from the hostname the console gives you', () => {
      expect(
        isClusterUrl('redis://clustercfg.redis-yiji.6ea0wx.use2.cache.amazonaws.com:6379'),
      ).toBe(true);
      expect(isClusterUrl('redis://localhost:6379')).toBe(false);
    });
  });

  describe('Socket.IO transports are explicit', () => {
    /** Config validation demands these; they are irrelevant to transports. */
    function withEnv<T>(extra: Record<string, string>, fn: () => T): T {
      const keys = ['YIJI_JWT_SECRET', 'SVC_GATEWAY_TOKEN', 'SOCKET_TRANSPORTS'];
      const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      process.env.YIJI_JWT_SECRET = 'x'.repeat(40);
      process.env.SVC_GATEWAY_TOKEN = 'svc-token';
      delete process.env.SOCKET_TRANSPORTS;
      Object.assign(process.env, extra);
      try {
        return fn();
      } finally {
        for (const k of keys) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
      }
    }

    it('passes a configured transport list to the server', () => {
      expect(INDEX_SRC).toContain('transports: config.SOCKET_TRANSPORTS');
    });

    it('defaults to polling+websocket, which REQUIRES ALB stickiness', () => {
      const cfg = withEnv({}, () => loadConfig());
      expect(cfg.SOCKET_TRANSPORTS).toEqual(['polling', 'websocket']);
    });

    it('can be narrowed to websocket-only, removing the stickiness requirement', () => {
      const cfg = withEnv({ SOCKET_TRANSPORTS: 'websocket' }, () => loadConfig());
      expect(cfg.SOCKET_TRANSPORTS).toEqual(['websocket']);
    });

    it('tolerates spaces around the separator', () => {
      const cfg = withEnv({ SOCKET_TRANSPORTS: ' websocket , polling ' }, () => loadConfig());
      expect(cfg.SOCKET_TRANSPORTS).toEqual(['websocket', 'polling']);
    });

    it('rejects an unknown transport instead of starting with a broken list', () => {
      expect(() => withEnv({ SOCKET_TRANSPORTS: 'carrier-pigeon' }, () => loadConfig())).toThrow();
    });
  });
});
