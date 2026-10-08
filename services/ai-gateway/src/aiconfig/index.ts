import type { Redis } from 'ioredis';
import { AiFeatureConfig } from '@yiji/shared-types';

/**
 * Redis-backed AI config.
 *
 * The admin portal writes the config; the gateway reads it on every request
 * (sub-ms — same Redis as everything else).
 *
 * ONE GLOBAL CONFIG IS THE DEFAULT; a vendor MAY have an override (MV-4,
 * EMA-73) under `ai:config:vendor:<CRM vendor id>`, read first. The override is
 * PARTIAL: whatever it names wins, everything else comes from the global
 * config, so switching one feature off for one vendor does not freeze that
 * vendor's cap or quotas at whatever the global said on the day. No override
 * (today, for every vendor) reads exactly the global config.
 */

const KEY = 'ai:config:global';
export const vendorConfigKey = (vendorId: string): string => `ai:config:vendor:${vendorId}`;

type Config = typeof AiFeatureConfig._type;

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AiConfigStore {
  constructor(private readonly redis: Redis) {}

  /** The config for `vendorId` (its override over the global), or the global one. */
  async get(vendorId?: string): Promise<Config> {
    const [globalRaw, vendorRaw] = await Promise.all([
      this.redis.get(KEY),
      vendorId ? this.redis.get(vendorConfigKey(vendorId)) : Promise.resolve(null),
    ]);
    const global = parseObject(globalRaw) ?? {};
    const override = parseObject(vendorRaw) ?? {};
    try {
      return AiFeatureConfig.parse({ ...global, ...override });
    } catch {
      // A corrupt override must not take the vendor's AI down with it — fall
      // back to the global config, then to the defaults.
      try {
        return AiFeatureConfig.parse(global);
      } catch {
        return AiFeatureConfig.parse({});
      }
    }
  }

  async set(input: unknown): Promise<Config> {
    const config = AiFeatureConfig.parse(input);
    await this.redis.set(KEY, JSON.stringify(config));
    return config;
  }

  /**
   * Write a vendor's override. Validated as a PARTIAL config — only the keys
   * given are stored, so the rest keeps following the global config.
   */
  async setForVendor(vendorId: string, input: unknown): Promise<Config> {
    const partial = AiFeatureConfig.partial().parse(input ?? {});
    await this.redis.set(vendorConfigKey(vendorId), JSON.stringify(partial));
    return this.get(vendorId);
  }

  /** Drop a vendor's override; it follows the global config again. */
  async clearVendor(vendorId: string): Promise<void> {
    await this.redis.del(vendorConfigKey(vendorId));
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
  '/help-assistant': 'helpAssistant',
};
