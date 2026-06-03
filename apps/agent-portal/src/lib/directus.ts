import { createAuthClient, browserAuthStorage } from '@yiji/shared-config';

const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

export const auth = createAuthClient({
  url: DIRECTUS_URL,
  storage: browserAuthStorage('yiji_agent_auth', localStorage),
});

/** Authenticated Directus client for reads (conversations, messages, ...). */
export const directus = auth.client;
