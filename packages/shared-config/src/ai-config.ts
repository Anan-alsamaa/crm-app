import { envKey } from './redis.js';

/**
 * WHERE THE AI SETTINGS LIVE (one definition for every service).
 *
 * The AI gateway owns the settings (the admin portal saves them through it);
 * the socket gateway READS them too since Maha (owner, 2026-11-09): it must
 * know at the customer's message whether Maha takes the chat, and every
 * service in one environment shares one Redis. Per environment via envKey;
 * the bare legacy key is read as a fallback (see the AI gateway's store).
 */
export const AI_CONFIG_LEGACY_KEY = 'ai:config:global';
export const aiConfigLegacyVendorKey = (vendorId: string): string => `ai:config:vendor:${vendorId}`;
export const aiConfigKey = (): string => envKey(AI_CONFIG_LEGACY_KEY);
export const aiConfigVendorKey = (vendorId: string): string =>
  envKey(aiConfigLegacyVendorKey(vendorId));

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The global config and the vendor's PARTIAL override, unparsed. Callers parse
 * `{ ...global, ...override }` with `AiFeatureConfig` (falling back to the
 * global alone if the override is corrupt).
 */
export async function readAiConfigRaw(
  get: (key: string) => Promise<string | null>,
  vendorId?: string | null,
): Promise<{ global: Record<string, unknown>; override: Record<string, unknown> }> {
  const [globalRaw, vendorRaw] = await Promise.all([
    get(aiConfigKey()).then((v) => v ?? get(AI_CONFIG_LEGACY_KEY)),
    vendorId
      ? get(aiConfigVendorKey(vendorId)).then((v) => v ?? get(aiConfigLegacyVendorKey(vendorId)))
      : Promise.resolve(null),
  ]);
  return { global: parseObject(globalRaw) ?? {}, override: parseObject(vendorRaw) ?? {} };
}

/**
 * Maha's spend this month for a vendor (SAR, a float), written by the AI
 * gateway after every answer and read by the socket gateway before a session
 * starts with her. Calendar month in UTC.
 */
export function mahaSpendKey(vendorId: string, now: Date = new Date()): string {
  const m = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${envKey('maha:spend')}:${vendorId}:${m}`;
}
