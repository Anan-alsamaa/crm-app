import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// The hook pulls asset bytes through the authenticated Directus SDK client:
// `directus.request(readAssetBlob(fileId))`. Mock both so nothing hits the
// network. `request` is hoisted so it exists before the hoisted mock factories.
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
// readAssetBlob just tags the request; make it identity-ish so we can assert
// it was invoked with the file id.
vi.mock('@directus/sdk', () => ({
  readAssetBlob: vi.fn((id: string) => ({ __readAssetBlob: id })),
}));

import { readAssetBlob } from '@directus/sdk';
import { useAssetBlobUrl } from '../src/lib/useAssetBlobUrl.js';

let counter = 0;
/** Unique id per test — the hook keeps a module-level ref-counted cache, so
 *  reusing an id across tests would leak refs/blob urls between them. */
function uid(): string {
  counter += 1;
  return `file-${counter}`;
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  request.mockReset();
  (readAssetBlob as unknown as ReturnType<typeof vi.fn>).mockClear();
  createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as { tag?: string }).tag ?? 'x'}`);
  revokeObjectURL = vi.fn();
  // jsdom doesn't implement the object-URL APIs.
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeBlob(tag: string): Blob {
  const b = new Blob(['x']);
  Object.defineProperty(b, 'tag', { value: tag });
  return b;
}

describe('useAssetBlobUrl', () => {
  it('returns idle state when fileId is null', () => {
    const { result } = renderHook(() => useAssetBlobUrl(null, true));
    expect(result.current).toEqual({ url: null, loading: false, error: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns idle state when disabled', () => {
    const id = uid();
    const { result } = renderHook(() => useAssetBlobUrl(id, false));
    expect(result.current).toEqual({ url: null, loading: false, error: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('loads then resolves to an object URL on success', async () => {
    const id = uid();
    request.mockResolvedValueOnce(fakeBlob(id));
    const { result } = renderHook(() => useAssetBlobUrl(id, true));

    // Synchronously enters the loading branch.
    expect(result.current).toEqual({ url: null, loading: true, error: false });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ url: `blob:${id}`, loading: false, error: false });
    expect(readAssetBlob).toHaveBeenCalledWith(id);
    expect(request).toHaveBeenCalledWith({ __readAssetBlob: id });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('sets error state when the request rejects', async () => {
    const id = uid();
    request.mockRejectedValueOnce(new Error('403'));
    const { result } = renderHook(() => useAssetBlobUrl(id, true));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current).toEqual({ url: null, loading: false, error: true });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shares one download and one blob URL across concurrent viewers (ref-counted cache)', async () => {
    const id = uid();
    request.mockResolvedValueOnce(fakeBlob(id));

    const a = renderHook(() => useAssetBlobUrl(id, true));
    const b = renderHook(() => useAssetBlobUrl(id, true));

    await waitFor(() => expect(a.result.current.url).toBe(`blob:${id}`));
    await waitFor(() => expect(b.result.current.url).toBe(`blob:${id}`));

    // De-duped: exactly one network request + one object URL for both viewers.
    expect(request).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    // Unmounting the first viewer must NOT revoke — second still holds a ref.
    a.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // Last viewer gone → blob URL revoked exactly once.
    b.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id}`);
  });

  it('serves a subsequent mount from cache without re-downloading', async () => {
    const id = uid();
    request.mockResolvedValueOnce(fakeBlob(id));

    const first = renderHook(() => useAssetBlobUrl(id, true));
    await waitFor(() => expect(first.result.current.url).toBe(`blob:${id}`));
    expect(request).toHaveBeenCalledTimes(1);

    // Cache hit path: refs++ and returns the same url, no new request.
    const second = renderHook(() => useAssetBlobUrl(id, true));
    await waitFor(() => expect(second.result.current.url).toBe(`blob:${id}`));
    expect(request).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('releases the acquired ref when unmounted after resolve', async () => {
    const id = uid();
    request.mockResolvedValueOnce(fakeBlob(id));
    const { result, unmount } = renderHook(() => useAssetBlobUrl(id, true));
    await waitFor(() => expect(result.current.url).toBe(`blob:${id}`));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id}`);
  });

  it('balances the ref when unmounted before the download resolves', async () => {
    const id = uid();
    let resolve!: (b: Blob) => void;
    request.mockReturnValueOnce(
      new Promise<Blob>((r) => {
        resolve = r;
      }),
    );

    const { result, unmount } = renderHook(() => useAssetBlobUrl(id, true));
    expect(result.current.loading).toBe(true);

    // Unmount while the request is still in flight.
    unmount();
    // Now let it resolve — the acquire still completes and caches, but the
    // effect cleanup's `active=false` path must release it, revoking the url.
    resolve(fakeBlob(id));

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1));
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id}`);
  });

  it('re-acquires when the fileId changes and releases the old one', async () => {
    const id1 = uid();
    const id2 = uid();
    request.mockImplementation((req: { __readAssetBlob: string }) =>
      Promise.resolve(fakeBlob(req.__readAssetBlob)),
    );

    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string }) => useAssetBlobUrl(id, true),
      { initialProps: { id: id1 } },
    );
    await waitFor(() => expect(result.current.url).toBe(`blob:${id1}`));

    rerender({ id: id2 });
    await waitFor(() => expect(result.current.url).toBe(`blob:${id2}`));

    // Switching away from id1 released its only ref → revoked.
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id1}`);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id2}`);
  });

  it('resets to idle when enabled flips to false', async () => {
    const id = uid();
    request.mockResolvedValueOnce(fakeBlob(id));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAssetBlobUrl(id, enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.url).toBe(`blob:${id}`));

    rerender({ enabled: false });
    await waitFor(() =>
      expect(result.current).toEqual({ url: null, loading: false, error: false }),
    );
    // Disabling releases the ref → url revoked.
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${id}`);
  });
});
