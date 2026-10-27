import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { NewVersionBanner, hasUnsavedText } from '@yiji/ui';

/*
 * THE SAFE AUTOMATIC RELOAD (owner, 2026-10-27: "the issues shouldnt occur,
 * need a solid fix"). After Update now, tabs nobody reloaded - the TV screen
 * above all - kept running a build that loaded every ticket. A newer build is
 * now taken up on its own: at once in a background tab, after 5 idle minutes on
 * screen, and never while there is typed, unsent text.
 */
const reload = vi.fn();

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  reload.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  // The page loaded bundle A; the server now serves bundle B.
  const s = document.createElement('script');
  s.setAttribute('src', '/assets/index-AAAA.js');
  document.head.appendChild(s);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => '<script src="/assets/index-BBBB.js">' })),
  );
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function becomeStale() {
  render(<NewVersionBanner intervalMs={1000} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100);
  });
}

describe('NewVersionBanner — automatic reload', () => {
  it('reloads a background tab as soon as it goes to the background', async () => {
    await becomeStale();
    expect(reload).not.toHaveBeenCalled();
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reload).toHaveBeenCalled();
  });

  it('reloads an on-screen tab (the TV) after 5 idle minutes', async () => {
    await becomeStale();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(reload).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(reload).toHaveBeenCalled();
  });

  it('never reloads while there is typed, unsent text', async () => {
    const ta = document.createElement('textarea');
    ta.value = 'half-written reply';
    document.body.appendChild(ta);
    await becomeStale();
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('activity on screen postpones the reload', async () => {
    await becomeStale();
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000);
      });
      window.dispatchEvent(new Event('pointerdown'));
    }
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('hasUnsavedText', () => {
  it('sees a non-empty textarea and ignores empty ones', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    expect(hasUnsavedText()).toBe(false);
    ta.value = 'x';
    expect(hasUnsavedText()).toBe(true);
  });
});
