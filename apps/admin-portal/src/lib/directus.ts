import { browserAuthStorage, createAuthClient, resolveUrl } from '@yiji/shared-config';

const DIRECTUS_URL = resolveUrl(
  'DIRECTUS_URL',
  import.meta.env.VITE_DIRECTUS_URL,
  'http://localhost:8055',
);

/*
 * THIS PORTAL'S OWN SESSION — see the matching note in the agent portal.
 *
 * A shared Directus host meant a shared session cookie, so the two portals were
 * one login. Separate storage keys make them separate sign-ins.
 */
export const auth = createAuthClient({
  url: DIRECTUS_URL,
  mode: 'json',
  storage:
    typeof localStorage === 'undefined'
      ? undefined
      : browserAuthStorage('yiji.admin.session', localStorage),
});

/** The authenticated Directus client, for CRUD (users, teams, ...). */
export const directus = auth.client;
