import { useEffect, useState } from 'react';
import { assetUrl, auth } from './directus.js';

/**
 * Directus files are private, so an <img src> would 403. This fetches the asset
 * with the agent's bearer token once per file id and hands back an object URL,
 * ref-counted across components so the same image isn't downloaded twice and
 * the blob URL is revoked only when the last viewer unmounts.
 */

const cache = new Map<string, { url: string; refs: number }>();
const inflight = new Map<string, Promise<string>>();

async function acquire(fileId: string): Promise<string> {
  const hit = cache.get(fileId);
  if (hit) {
    hit.refs++;
    return hit.url;
  }
  let p = inflight.get(fileId);
  if (!p) {
    p = (async () => {
      const token = await auth.getToken();
      const res = await fetch(assetUrl(fileId), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`asset_${res.status}`);
      return URL.createObjectURL(await res.blob());
    })();
    inflight.set(fileId, p);
  }
  const url = await p;
  inflight.delete(fileId);
  const entry = cache.get(fileId);
  if (entry) {
    entry.refs++;
    return entry.url;
  }
  cache.set(fileId, { url, refs: 1 });
  return url;
}

function release(fileId: string): void {
  const entry = cache.get(fileId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url);
    cache.delete(fileId);
  }
}

export function useAssetBlobUrl(
  fileId: string | null,
  enabled: boolean,
): { url: string | null; loading: boolean; error: boolean } {
  const [state, setState] = useState<{ url: string | null; loading: boolean; error: boolean }>({
    url: null,
    loading: false,
    error: false,
  });

  useEffect(() => {
    if (!fileId || !enabled) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let active = true;
    let acquired = false;
    setState({ url: null, loading: true, error: false });
    acquire(fileId)
      .then((url) => {
        acquired = true;
        if (active) setState({ url, loading: false, error: false });
        else release(fileId); // unmounted before resolve — balance the acquire
      })
      .catch(() => {
        if (active) setState({ url: null, loading: false, error: true });
      });
    return () => {
      active = false;
      if (acquired) release(fileId);
    };
  }, [fileId, enabled]);

  return state;
}
