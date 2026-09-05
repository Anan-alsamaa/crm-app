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
 * The environment's Redis namespace.
 *
 * Staging and production SHARE one ElastiCache cluster (a cost decision — the
 * cluster is single-shard and barely loaded). Nothing else separates them, so
 * this string is the entire boundary: without it both environments read and
 * write the same queues, and a staging SLA sweep would process production
 * tickets. Derived from NODE_ENV so it cannot be forgotten in a deploy, with an
 * explicit override for anyone running a third environment.
 *
 * Production is deliberately the bare name rather than `yiji-prod`: production
 * keys already exist under it, and renaming them would strand every in-flight
 * job at the moment of the change.
 */
export function envNamespace(): string {
  const explicit = process.env.REDIS_NAMESPACE?.trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === 'production' ? 'yiji' : 'yiji-staging';
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
 *
 * The tag also carries the environment (see envNamespace), which is what keeps
 * a shared cluster from merging staging and production into one queue. Both
 * halves matter: the braces give co-location, the name gives isolation.
 */
export function bullPrefix(url: string): string | undefined {
  return isClusterUrl(url) ? `{${envNamespace()}}` : undefined;
}

/**
 * Namespace an ordinary (non-BullMQ) Redis key.
 *
 * The AI cache and the rate limiters write plain keys, which are just as shared
 * as the queues are — an unprefixed `rl:<ip>` means staging traffic consumes a
 * production rate-limit budget, and a cached AI answer crosses environments.
 * No hash tag here: these are single-key operations, so co-location is
 * irrelevant and braces would only add noise.
 */
export function envKey(key: string): string {
  return `${envNamespace()}:${key}`;
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
