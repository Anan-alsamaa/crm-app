import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * lib/sound.ts holds module-level state (muted, lastSelfSend, ctx) initialized
 * from localStorage at import time. Each test uses vi.resetModules() + a fresh
 * dynamic import so the initial `muted` value reflects the localStorage stub.
 */

type SoundModule = typeof import('../src/lib/sound.js');

/** Build a controllable AudioContext mock and expose its instances. */
function installAudioContextMock() {
  const oscillators: Array<{
    type: string;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const contexts: Array<{ resume: ReturnType<typeof vi.fn>; state: string }> = [];

  class MockAudioContext {
    state = 'suspended';
    currentTime = 0;
    resume = vi.fn();
    constructor() {
      contexts.push(this as unknown as { resume: ReturnType<typeof vi.fn>; state: string });
    }
    createOscillator() {
      const osc = {
        type: '',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(() => gainReturn),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(() => this.destination),
      };
    }
    destination = {};
  }

  // createOscillator().connect(gain).connect(destination): the first connect
  // must return the gain node (which itself has a .connect).
  const gainReturn = { connect: vi.fn() };

  return { MockAudioContext, oscillators, contexts };
}

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

async function freshImport(): Promise<SoundModule> {
  vi.resetModules();
  return import('../src/lib/sound.js');
}

describe('lib/sound state', () => {
  it('defaults to unmuted when localStorage has no flag', async () => {
    const mod = await freshImport();
    expect(mod.isSoundMuted()).toBe(false);
  });

  it('initializes muted from a persisted "1" flag', async () => {
    localStorage.setItem('yiji.agent.soundMuted', '1');
    const mod = await freshImport();
    expect(mod.isSoundMuted()).toBe(true);
  });

  it('persists mute state to localStorage as "1" / "0"', async () => {
    const mod = await freshImport();
    mod.setSoundMuted(true);
    expect(mod.isSoundMuted()).toBe(true);
    expect(localStorage.getItem('yiji.agent.soundMuted')).toBe('1');
    mod.setSoundMuted(false);
    expect(mod.isSoundMuted()).toBe(false);
    expect(localStorage.getItem('yiji.agent.soundMuted')).toBe('0');
  });

  it('keeps the in-memory value when localStorage.setItem throws', async () => {
    const mod = await freshImport();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    mod.setSoundMuted(true);
    expect(mod.isSoundMuted()).toBe(true);
  });
});

describe('playMessageBeep', () => {
  it('does nothing when muted', async () => {
    const { MockAudioContext, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    const mod = await freshImport();
    mod.setSoundMuted(true);
    mod.playMessageBeep();
    expect(contexts).toHaveLength(0);
  });

  it('does nothing within 1500ms of a self-send', async () => {
    const { MockAudioContext, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const mod = await freshImport();
    mod.noteSelfSend();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.500Z')); // 500ms later
    mod.playMessageBeep();
    expect(contexts).toHaveLength(0);
  });

  it('plays after the self-send suppression window elapses', async () => {
    const { MockAudioContext, oscillators, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const mod = await freshImport();
    mod.noteSelfSend();
    vi.setSystemTime(new Date('2026-07-01T00:00:02Z')); // 2000ms later > 1500
    mod.playMessageBeep();
    expect(contexts).toHaveLength(1);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]!.start).toHaveBeenCalled();
    expect(oscillators[0]!.stop).toHaveBeenCalled();
  });

  it('synthesizes a beep and resumes a suspended context', async () => {
    const { MockAudioContext, oscillators, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    const mod = await freshImport();
    mod.playMessageBeep();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.resume).toHaveBeenCalled();
    expect(oscillators[0]!.type).toBe('sine');
    expect(oscillators[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(oscillators[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(1318, 0.09);
  });

  it('reuses the same AudioContext across calls', async () => {
    const { MockAudioContext, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    const mod = await freshImport();
    mod.playMessageBeep();
    mod.playMessageBeep();
    expect(contexts).toHaveLength(1);
  });

  it('does not call resume when the context is already running', async () => {
    const { MockAudioContext, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', MockAudioContext);
    const mod = await freshImport();
    mod.playMessageBeep(); // first call: suspended -> resume + becomes reused ctx
    // Force the reused context to a running state and clear the spy.
    contexts[0]!.state = 'running';
    contexts[0]!.resume.mockClear();
    mod.playMessageBeep();
    expect(contexts[0]!.resume).not.toHaveBeenCalled();
  });

  it('falls back to webkitAudioContext when AudioContext is absent', async () => {
    const { MockAudioContext, contexts } = installAudioContextMock();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', MockAudioContext);
    const mod = await freshImport();
    mod.playMessageBeep();
    expect(contexts).toHaveLength(1);
  });

  it('returns quietly when no AudioContext constructor exists', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const mod = await freshImport();
    expect(() => mod.playMessageBeep()).not.toThrow();
  });

  it('swallows errors thrown while building the beep', async () => {
    class ThrowingAudioContext {
      state = 'running';
      currentTime = 0;
      resume = vi.fn();
      createOscillator() {
        throw new Error('audio blocked');
      }
      createGain() {
        return {};
      }
      destination = {};
    }
    vi.stubGlobal('AudioContext', ThrowingAudioContext);
    const mod = await freshImport();
    expect(() => mod.playMessageBeep()).not.toThrow();
  });
});
