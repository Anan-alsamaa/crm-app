import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * host.ts is the chat page's script. It has no exports: importing it decides,
 * once, between taking a walk-in handoff, running the dev harness, and sending
 * the visitor to the phone form. Mock the two things it can reach for and
 * import it fresh per case.
 */
const initSpy = vi.fn();
vi.mock('../src/embed.js', () => ({
  YijiChat: { init: (...args: unknown[]) => initSpy(...args) },
}));

const demoSpy = vi.fn();
vi.mock('../src/demo.js', () => {
  demoSpy();
  return {};
});

async function loadHost(): Promise<void> {
  vi.resetModules();
  await import('../src/host.js');
  // The dev branch imports the harness asynchronously; let it settle.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  initSpy.mockReset();
  demoSpy.mockReset();
  sessionStorage.clear();
  vi.stubEnv('VITE_SOCKET_URL', 'http://localhost:8080');
  vi.stubGlobal('location', {
    replace: vi.fn(),
    origin: 'https://chat.example',
    href: 'https://chat.example/',
    pathname: '/',
    search: '',
  });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a walk-in handoff opens the chat', () => {
  it('uses the gateway-signed token and mints nothing', async () => {
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    sessionStorage.setItem('yiji.walkInCloseUrl', 'closeapp://');
    await loadHost();

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0]).toEqual({
      gatewayUrl: 'http://localhost:8080',
      token: 'gateway-signed',
      locale: 'en',
      autoOpen: true,
      closeUrl: 'closeapp://',
    });
    expect(demoSpy).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('takes the handoff once, so a later refresh cannot replay the token', async () => {
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(sessionStorage.getItem('yiji.walkInToken')).toBeNull();
    expect(sessionStorage.getItem('yiji.walkInCloseUrl')).toBeNull();
  });

  it('omits closeUrl when the QR page set none', async () => {
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).not.toHaveProperty('closeUrl');
  });
});

describe('with nothing waiting', () => {
  it('runs the dev harness on the dev server', async () => {
    vi.stubEnv('DEV', true);
    await loadHost();
    expect(demoSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('sends a published visitor to the phone form, and never near the harness', async () => {
    // Opened "normally", from a link or a typed address: the page IS the
    // walk-in flow. And a published page must not know the harness exists.
    vi.stubEnv('DEV', false);
    await loadHost();
    expect(location.replace).toHaveBeenCalledWith('/walk-in.html');
    expect(demoSpy).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('treats unreadable storage as nothing waiting', async () => {
    vi.stubEnv('DEV', false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await loadHost();
    expect(location.replace).toHaveBeenCalledWith('/walk-in.html');
  });
});

describe('where the widget connects', () => {
  it('falls back to the page\u2019s own origin on a published host with no URL baked in', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_SOCKET_URL', '');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ gatewayUrl: 'https://chat.example' });
  });

  it('falls back to the local gateway on the dev server', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_SOCKET_URL', '');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ gatewayUrl: 'http://localhost:8080' });
  });
});
