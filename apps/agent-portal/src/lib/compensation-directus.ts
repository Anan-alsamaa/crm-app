import { createDirectus, rest, staticToken } from '@directus/sdk';
import { resolveOptionalUrl } from '@yiji/shared-config';
import { directus } from './directus.js';

/**
 * Compensation lives in a DIFFERENT Directus from the rest of the CRM.
 *
 * The CRM owns the compensation *frontend* — the ops queue, the detail page and
 * the workflow buttons — but the collections (`compensation_requests`,
 * `Com_Coupons`, the issue catalog), the workflow flows and the account they are
 * reached with all belong to a separate, pre-existing Directus that this project
 * does not provision. So `/compensation` must not talk to the CRM's own
 * instance, and the CRM bootstrap must not try to create that schema.
 *
 * Auth differs too. The CRM client uses the logged-in agent's cookie session
 * (H-2), but an agent has no account on the compensation instance — so this
 * client authenticates with a STATIC service token instead.
 *
 * SECURITY NOTE: a `VITE_` variable is baked into the bundle and is therefore
 * readable by anyone who loads the portal. Point this at a token whose Directus
 * policy is scoped to exactly the compensation collections and nothing else, and
 * treat it as public. If that is unacceptable, the right shape is to proxy these
 * reads through the socket-gateway so the token stays server-side — a bigger
 * change than wiring a second client, and worth doing before external rollout.
 *
 * Unset (the default) → fall back to the CRM client, so local development and
 * the existing tests keep working against the cloned schema on :8055.
 */
/* Optional on purpose: unset falls back to the CRM client, so this must be
 * able to stay undefined rather than take a loopback default. */
const URL_ = resolveOptionalUrl(
  'COMPENSATION_DIRECTUS_URL',
  import.meta.env.VITE_COMPENSATION_DIRECTUS_URL,
);
const TOKEN = import.meta.env.VITE_COMPENSATION_DIRECTUS_TOKEN?.trim();

/** True when a dedicated compensation instance is configured. */
export const usesExternalCompensationDirectus = Boolean(URL_);

function build() {
  if (!URL_) return directus;
  const base = createDirectus(URL_).with(rest());
  return TOKEN ? base.with(staticToken(TOKEN)) : base;
}

/**
 * Client for every compensation read/write and flow trigger. Deliberately a
 * separate export rather than a parameter on the shared client: it makes the
 * split visible at every call site.
 */
export const compensationDirectus = build() as typeof directus;
