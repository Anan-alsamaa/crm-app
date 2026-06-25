import type { Redis } from 'ioredis';
import { AiFeatureConfig } from '@yiji/shared-types';

/**
 * Redis-backed AI config singleton.
 *
 * The admin portal writes the config; the gateway reads it on every request
 * (sub-ms — same Redis as everything else). One global key today; per-vendor
 * config can be added later by suffixing the key.
 */

const KEY = 'ai:config:global';

export class AiConfigStore {
  constructor(private readonly redis: Redis) {}

  async get(): Promise<typeof AiFeatureConfig._type> {
    const raw = await this.redis.get(KEY);
    if (!raw) return AiFeatureConfig.parse({});
    try {
      return AiFeatureConfig.parse(JSON.parse(raw));
    } catch {
      // Corrupt entry — fall back to defaults rather than crash.
      return AiFeatureConfig.parse({});
    }
  }

  async set(input: unknown): Promise<typeof AiFeatureConfig._type> {
    const config = AiFeatureConfig.parse(input);
    await this.redis.set(KEY, JSON.stringify(config));
    return config;
  }
}

/** Map feature flag key → endpoint path so we can gate uniformly. */
export const FEATURE_BY_ENDPOINT: Record<string, keyof typeof AiFeatureConfig._type> = {
  '/summarize-conversation': 'summarize',
  '/suggest-reply': 'suggestReply',
  '/analyze-sentiment': 'analyzeSentiment',
  '/detect-intent': 'detectIntent',
  '/extract-entities': 'extractEntities',
  '/semantic-search': 'semanticSearch',
  '/score-lead': 'scoreLead',
  '/order-assist': 'orderAssist',
};
