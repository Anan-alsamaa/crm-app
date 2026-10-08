/**
 * PER-VENDOR SECRETS (MV-3, EMA-72).
 *
 * Each vendor has its OWN webhook secret and its OWN chat-login (customer JWT)
 * secret, so one vendor can never sign for another. The owner has not
 * approved storing secrets in the database (no encryption key exists for it
 * yet), so they come from SERVICE CONFIGURATION — environment variables on
 * the service's task definition — never from the `vendors` table.
 *
 * THE NAMING CONVENTION. A vendor is named by its `webhook_path_key` (the
 * `<key>` in `/webhooks/<key>`):
 *
 *   - the Yiji vendor (key `yiji`) keeps the variables it has always used:
 *       YIJI_JWT_SECRET, YIJI_WEBHOOK_SECRET
 *   - every other vendor:
 *       VENDOR_<KEY>_JWT_SECRET, VENDOR_<KEY>_WEBHOOK_SECRET
 *     where KEY is the path key upper-cased with every non-alphanumeric
 *     character replaced by `_` (`acme-foods` -> `VENDOR_ACME_FOODS_JWT_SECRET`).
 *
 * NO FALLBACK. A vendor whose variable is missing or blank has NO secret: its
 * webhook and its chat login are refused. It never borrows Yiji's secret —
 * that would let a token signed for Yiji open a session as another vendor,
 * which is exactly the isolation this exists to guarantee.
 *
 * Pure: the environment is passed in, so this module is safe in the browser
 * bundles that import shared-types (it is only USED by services).
 *
 * See docs/VENDOR-SECRETS.md.
 */

/** The Yiji vendor's `webhook_path_key` — the one key with legacy variable names. */
export const YIJI_VENDOR_KEY = 'yiji';

/** The shape a `webhook_path_key` must have (lowercase letters, digits, dashes). */
export const VENDOR_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `acme-foods` -> `ACME_FOODS`. */
export function vendorEnvSegment(vendorKey: string): string {
  return vendorKey
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

/** The env var names holding a vendor's secrets. */
export function vendorSecretEnvNames(vendorKey: string): { jwt: string; webhook: string } {
  const key = vendorKey.trim().toLowerCase();
  if (key === YIJI_VENDOR_KEY) return { jwt: 'YIJI_JWT_SECRET', webhook: 'YIJI_WEBHOOK_SECRET' };
  const seg = vendorEnvSegment(key);
  return { jwt: `VENDOR_${seg}_JWT_SECRET`, webhook: `VENDOR_${seg}_WEBHOOK_SECRET` };
}

export interface VendorSecrets {
  /** The customer-JWT secret for this vendor key, or null (= refuse). */
  jwtSecret(vendorKey: string): string | null;
  /** The webhook HMAC secret for this vendor key, or null (= refuse). */
  webhookSecret(vendorKey: string): string | null;
}

export type SecretEnv = Readonly<Record<string, string | undefined>>;

/** Read vendor secrets from a service's environment by the convention above. */
export function createEnvVendorSecrets(env: SecretEnv): VendorSecrets {
  const read = (name: string): string | null => {
    const v = env[name]?.trim();
    return v ? v : null;
  };
  const valid = (vendorKey: string): boolean =>
    typeof vendorKey === 'string' && VENDOR_KEY_PATTERN.test(vendorKey.trim().toLowerCase());
  return {
    jwtSecret: (vendorKey) => (valid(vendorKey) ? read(vendorSecretEnvNames(vendorKey).jwt) : null),
    webhookSecret: (vendorKey) =>
      valid(vendorKey) ? read(vendorSecretEnvNames(vendorKey).webhook) : null,
  };
}
