import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Content-hash response cache.
 *
 * Key = `aicache:<endpoint>:<sha256(redacted_input)>`. We hash the redacted
 * payload (post-PII-redaction) so identical context produces a cache hit
 * regardless of the user. Default TTL: 15 minutes — short enough for
 * conversation context to stay fresh but long enough to amortize bursts.
 */

export class ResponseCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 900,
    private readonly keyPrefix = 'aicache',
  ) {}

  private hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  key(endpoint: string, input: string): string {
    return `${this.keyPrefix}:${endpoint}:${this.hash(input)}`;
  }

  async get<T>(endpoint: string, input: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(endpoint, input));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(endpoint: string, input: string, value: T): Promise<void> {
    await this.redis.set(this.key(endpoint, input), JSON.stringify(value), 'EX', this.ttlSeconds);
  }
}
