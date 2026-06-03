import { createAuthClient, browserAuthStorage } from '@yiji/shared-config';

const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

export const auth = createAuthClient({
  url: DIRECTUS_URL,
  storage: browserAuthStorage('yiji_admin_auth', localStorage),
});

/** The authenticated Directus client, for CRUD (users, teams, ...). */
export const directus = auth.client;
