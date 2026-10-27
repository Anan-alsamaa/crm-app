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

/*
 * A HALF-MADE TICKET IS NEVER LOST (owner, 2026-10-27): the agent may step to
 * another tab to look an order up mid-ticket - the tab goes to the background,
 * and must still not reload.
 */
describe('hasUnsavedText — work in progress', () => {
  it('blocks while a dialog is open', () => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    document.body.appendChild(d);
    expect(hasUnsavedText()).toBe(true);
  });

  it('blocks while any form field holds a value, focused or not', () => {
    const f = document.createElement('form');
    const i = document.createElement('input');
    i.value = '1355180';
    f.appendChild(i);
    document.body.appendChild(f);
    expect(hasUnsavedText()).toBe(true);
  });

  it('blocks a background reload of a half-filled ticket', async () => {
    const f = document.createElement('form');
    const i = document.createElement('input');
    i.setAttribute('type', 'tel');
    i.value = '0551234567';
    f.appendChild(i);
    document.body.appendChild(f);
    await becomeStale();
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('is clear on an idle page with empty fields', () => {
    const f = document.createElement('form');
    f.appendChild(document.createElement('input'));
    document.body.appendChild(f);
    expect(hasUnsavedText()).toBe(false);
  });
});
