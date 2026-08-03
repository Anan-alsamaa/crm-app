import { Redis, Cluster, type RedisOptions, type ClusterOptions } from 'ioredis';

/**
 * Redis client factory that copes with BOTH ElastiCache topologies.
 *
 * ElastiCache exposes two shapes and they are NOT interchangeable:
 *   - cluster mode DISABLED → a single primary endpoint, a normal client works;
 *   - cluster mode ENABLED  → a `clustercfg.*` CONFIGURATION endpoint, where keys
 *     are spread across shards and the server answers with MOVED redirects.
 *
 * A standalone client cannot follow MOVED, so pointing `new Redis(url)` at a
 * `clustercfg.` host fails at runtime — not at boot, but on the first key that
 * happens to hash to another shard, which makes it look intermittent.
 *
 * Detection is on the hostname because that is what the operator actually pastes
 * from the AWS console; `REDIS_CLUSTER=true|false` overrides it when a proxy or
 * custom DNS name hides the shape.
 */
export function isClusterUrl(url: string): boolean {
  const override = process.env.REDIS_CLUSTER?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  try {
    return new URL(url).hostname.startsWith('clustercfg.');
  } catch {
    return false;
  }
}

/**
 * BullMQ key prefix.
 *
 * BullMQ keeps a queue's keys in several Redis keys that it manipulates together
 * in Lua scripts. On a cluster those keys MUST live on one shard or the scripts
 * fail with CROSSSLOT. Redis only guarantees co-location for keys sharing a hash
 * tag — the part inside `{}` — so on a cluster every queue is prefixed with a
 * literal tag. Standalone keeps BullMQ's default prefix so existing keys (and
 * any in-flight jobs) are untouched.
 */
export function bullPrefix(url: string): string | undefined {
  return isClusterUrl(url) ? '{yiji}' : undefined;
}

/** Shared connection posture: BullMQ requires maxRetriesPerRequest: null. */
const BASE: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempts: number) => Math.min(attempts * 200, 5000),
};

/**
 * Build a client for `url`, cluster-aware. Returns `Redis | Cluster`; both
 * implement the command surface BullMQ, the Socket.IO adapter and our own code
 * use, so callers do not branch.
 */
export function createRedis(url: string, extra: RedisOptions = {}): Redis | Cluster {
  const options = { ...BASE, ...extra };
  if (!isClusterUrl(url)) return new Redis(url, options);

  const parsed = new URL(url);
  const clusterOptions: ClusterOptions = {
    // Applied to every node connection, not the cluster wrapper.
    redisOptions: {
      ...options,
      ...(parsed.password ? { password: parsed.password } : {}),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    },
    // ElastiCache advertises PRIVATE node addresses; without this the client
    // discovers nodes it cannot route to from outside the VPC.
    dnsLookup: (address: string, callback: (err: null, addr: string) => void) =>
      callback(null, address),
  };
  return new Cluster(
    [{ host: parsed.hostname, port: Number(parsed.port || 6379) }],
    clusterOptions,
  );
}
