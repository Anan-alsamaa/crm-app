import { createAuthClient } from '@yiji/shared-config';

const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

// H-2: no storage arg → in-memory access token only; the refresh token lives in
// an httpOnly cookie set by Directus (unreadable by JS).
export const auth = createAuthClient({ url: DIRECTUS_URL });

/** The authenticated Directus client, for CRUD (users, teams, ...). */
export const directus = auth.client;
