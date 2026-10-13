import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endBusyIfStillGone } from '../src/connection.js';

/* A signed-out agent is not busy (owner, 2026-10-13): closing the browser
   left the Busy stretch open and the report counted the away time. */
describe('endBusyIfStillGone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const deps = (online: boolean) => ({
    directus: { endBusy: vi.fn(async () => 1) },
    logger: { info: vi.fn(), warn: vi.fn() },
    presenceStore: {
      online: vi.fn(),
      offline: vi.fn(),
      touch: vi.fn(),
      isOnline: vi.fn(async () => online),
    },
  });

  it('closes the stretch at the moment the agent LEFT, after the wait', async () => {
    const d = deps(false);
    endBusyIfStillGone('agent-away', d as never, 120_000);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(d.directus.endBusy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(d.directus.endBusy).toHaveBeenCalledWith('agent-away', '2026-10-13T12:00:00.000Z');
  });

  it('keeps Busy when the agent came back on any gateway instance', async () => {
    const d = deps(true);
    endBusyIfStillGone('agent-back', d as never, 120_000);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(d.directus.endBusy).not.toHaveBeenCalled();
  });
});
