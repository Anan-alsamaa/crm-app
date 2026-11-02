import { browserAuthStorage, createAuthClient, resolveUrl } from '@yiji/shared-config';

const DIRECTUS_URL = resolveUrl(
  'DIRECTUS_URL',
  import.meta.env.VITE_DIRECTUS_URL,
  'http://localhost:8055',
);

/*
 * THIS PORTAL'S OWN SESSION, per tab — the same rule as the agent and admin
 * portals: its own storage key, so signing in here does not sign anybody in
 * (or out) of the other two.
 */
export const auth = createAuthClient({
  url: DIRECTUS_URL,
  mode: 'json',
  storage:
    typeof sessionStorage === 'undefined'
      ? undefined
      : browserAuthStorage('yiji.marketing.session', sessionStorage),
});

/** The authenticated Directus client. */
export const directus = auth.client;
