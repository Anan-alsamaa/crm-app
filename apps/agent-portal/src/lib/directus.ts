import { readAssetBlob } from '@directus/sdk';
import { createAuthClient } from '@yiji/shared-config';

export const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

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

// H-2: no storage arg → in-memory access token only; the refresh token lives in
// an httpOnly cookie set by Directus (unreadable by JS).
export const auth = createAuthClient({ url: DIRECTUS_URL });

/** Authenticated Directus client for reads (conversations, messages, ...). */
export const directus = auth.client;
