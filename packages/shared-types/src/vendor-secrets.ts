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

/**
 * The env var names holding a vendor's PLATFORM API credentials (MV-7) — read
 * by the services that call the platform (ai-gateway, workers), never by the
 * browser and never from the `vendors` table.
 *
 *   - Yiji (key `yiji`): YIJI_API_KEY, YIJI_ADMIN_EMAIL, YIJI_ADMIN_PASSWORD
 *   - any other key:     VENDOR_<KEY>_API_KEY, VENDOR_<KEY>_ADMIN_EMAIL,
 *                        VENDOR_<KEY>_ADMIN_PASSWORD
 *
 * Same no-fallback rule as the secrets above: a vendor without its variables
 * has no credential; it never borrows Yiji's.
 */
export function vendorCredentialEnvNames(vendorKey: string): {
  apiKey: string;
  adminEmail: string;
  adminPassword: string;
} {
  const key = vendorKey.trim().toLowerCase();
  if (key === YIJI_VENDOR_KEY) {
    return {
      apiKey: 'YIJI_API_KEY',
      adminEmail: 'YIJI_ADMIN_EMAIL',
      adminPassword: 'YIJI_ADMIN_PASSWORD',
    };
  }
  const seg = vendorEnvSegment(key);
  return {
    apiKey: `VENDOR_${seg}_API_KEY`,
    adminEmail: `VENDOR_${seg}_ADMIN_EMAIL`,
    adminPassword: `VENDOR_${seg}_ADMIN_PASSWORD`,
  };
}

/** A vendor's platform credentials from env by the convention above; blanks are absent. */
export function vendorCredentialsFromEnv(
  env: SecretEnv,
  vendorKey: string,
): { apiKey?: string; adminEmail?: string; adminPassword?: string } {
  if (typeof vendorKey !== 'string' || !VENDOR_KEY_PATTERN.test(vendorKey.trim().toLowerCase())) {
    return {};
  }
  const names = vendorCredentialEnvNames(vendorKey);
  const out: { apiKey?: string; adminEmail?: string; adminPassword?: string } = {};
  for (const k of ['apiKey', 'adminEmail', 'adminPassword'] as const) {
    const v = env[names[k]]?.trim();
    if (v) out[k] = v;
  }
  return out;
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
