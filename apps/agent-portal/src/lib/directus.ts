import { readAssetBlob } from '@directus/sdk';
import { browserAuthStorage, createAuthClient, resolveUrl } from '@yiji/shared-config';

export const DIRECTUS_URL = resolveUrl(
  'DIRECTUS_URL',
  import.meta.env.VITE_DIRECTUS_URL,
  'http://localhost:8055',
);

/** Download/preview URL for a Directus file id (via the assets endpoint). */
export function assetUrl(fileId: string): string {
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

/**
 * Download an attachment. Directus files are private, so we pull the bytes
 * through the authenticated SDK client (`directus.request`) — NOT a manual
 * fetch with auth.getToken(). Under H-2 cookie auth the access token is
 * in-memory and short-lived; the SDK transparently refreshes it (and sends the
 * credentialed cookie), whereas a hand-rolled fetch breaks the moment the token
 * goes stale — which silently turned every image into a download-only chip.
 */
export async function downloadAsset(fileId: string, filename?: string): Promise<void> {
  const blob = await directus.request(readAssetBlob(fileId));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/*
 * THIS PORTAL'S OWN SESSION, not whatever the admin portal is signed in as.
 *
 * Both portals talk to the SAME Directus host, so under cookie auth they shared
 * one `directus_session_token` — opening the agent portal while signed into the
 * admin portal logged you straight in as the admin account, with no prompt
 * (owner, 2026-09-15). Two products with different roles must not share one
 * identity.
 *
 * `json` mode keeps the refresh token in this app's own storage key instead of
 * a shared cookie, so each portal signs in, stays signed in, and signs out on
 * its own. Reopening this portal still restores THIS session when it is valid.
 */
export const auth = createAuthClient({
  url: DIRECTUS_URL,
  mode: 'json',
  storage:
    typeof localStorage === 'undefined'
      ? undefined
      : browserAuthStorage('yiji.agent.session', localStorage),
});

/** Authenticated Directus client for reads (conversations, messages, ...). */
export const directus = auth.client;
