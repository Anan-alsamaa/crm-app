/**
 * Shared admin-credential resolution for the compensation-clone scripts.
 *
 * These are local dev tools, so they stay zero-config against a local Directus:
 * with no env vars set you get the local dev admin, exactly as before.
 *
 * The guard exists because those fallbacks are committed to git. Pointing a
 * script at a remote Directus without setting credentials would silently
 * authenticate to it with a password that is public in this repo — and the
 * failure would be a confusing `TypeError` on `.data` rather than "bad
 * credentials". Any non-local target must pass real credentials explicitly, the
 * same way extract-prod-flows.mjs already requires PROD_DIRECTUS_TOKEN.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const DEV_URL = 'http://localhost:8055';
const DEV_EMAIL = 'e.habibi@anan.sa';
const DEV_PASSWORD = '123456';

/**
 * @returns {{ url: string, email: string, password: string }}
 */
export function resolveAdmin() {
  const url = process.env.DIRECTUS_URL ?? DEV_URL;

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.error(`DIRECTUS_URL is not a valid URL: ${url}`);
    process.exit(1);
  }

  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;

  if (!LOCAL_HOSTNAMES.has(hostname) && (!email || !password)) {
    console.error(
      `Refusing to fall back to the committed dev credentials against a non-local Directus (${hostname}).\n` +
        'Set DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD explicitly for this target.',
    );
    process.exit(1);
  }

  return { url, email: email ?? DEV_EMAIL, password: password ?? DEV_PASSWORD };
}
