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
    const opts = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      gatewayUrl: 'http://localhost:8080',
      token: 'gateway-signed',
      autoOpen: true,
      closeUrl: 'closeapp://',
    });
    // The language is the customer's, not a constant — see the language block
    // below. What matters here is that the page passes one and can store a
    // change, and that it invented no token of its own.
    expect(['ar', 'en']).toContain(opts.locale);
    expect(typeof opts.onLocaleChange).toBe('function');
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
    //
    // The CLEAN path: the deploy serves the form under both keys, but this is
    // the address the customer is left looking at and the one a printed QR
    // code carries, so it must not end in `.html`.
    vi.stubEnv('DEV', false);
    await loadHost();
    expect(location.replace).toHaveBeenCalledWith('/walk-in');
    expect(demoSpy).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('treats unreadable storage as nothing waiting', async () => {
    vi.stubEnv('DEV', false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await loadHost();
    expect(location.replace).toHaveBeenCalledWith('/walk-in');
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

describe('the chat page opens in the customer’s language', () => {
  const phoneSpeaks = (...languages: string[]) =>
    vi.stubGlobal('navigator', { languages, language: languages[0] });

  beforeEach(() => localStorage.clear());

  it('hands the widget ARABIC when the phone asks for neither language', async () => {
    phoneSpeaks('fr-FR');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ locale: 'ar' });
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('follows a phone set to English', async () => {
    phoneSpeaks('en-US');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ locale: 'en' });
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('honours the choice made on the QR page, over the phone', async () => {
    // The two pages are one journey: switching to English on the form and
    // then being asked to read Arabic in the chat is the same bug twice.
    phoneSpeaks('ar-SA');
    localStorage.setItem('yiji.locale', 'en');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ locale: 'en' });
  });

  it('stores a switch made inside the chat', async () => {
    phoneSpeaks('ar-SA');
    sessionStorage.setItem('yiji.walkInToken', 'gateway-signed');
    await loadHost();
    const onLocaleChange = initSpy.mock.calls[0][0].onLocaleChange as (l: string) => void;
    onLocaleChange('en');
    expect(localStorage.getItem('yiji.locale')).toBe('en');
  });
});

describe('the address the visitor is left on', () => {
  it('never redirects on the dev server, so the .html path is not needed there', async () => {
    // Vite serves files, so there is no extensionless key — but the dev server
    // runs the harness instead of redirecting, so the question never arises.
    vi.stubEnv('DEV', true);
    sessionStorage.clear();
    await loadHost();
    expect(location.replace).not.toHaveBeenCalled();
  });
});

/*
 * THE YIJI APP'S DOOR.
 *
 * The app opens a web view at `…/?token=<JWT>` — one URL, no script tag, no
 * JavaScript on their side. These pin the two things that make it safe: the
 * token reaches the widget, and it does not stay in the address bar.
 */
describe('a token in the URL', () => {
  function withUrl(search: string) {
    vi.stubGlobal('location', {
      replace: vi.fn(),
      origin: 'https://chat.example',
      href: `https://chat.example/${search}`,
      pathname: '/',
      search,
    });
  }

  it('opens the chat with the token the app supplied', async () => {
    withUrl('?token=app-signed-jwt');
    await loadHost();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0]).toMatchObject({ token: 'app-signed-jwt', autoOpen: true });
  });

  it('strips the token from the address bar before the widget mounts', async () => {
    /*
     * A URL carrying a customer's session lands in history, in the Referer of
     * anything the page loads, and in any screenshot. A web view's history
     * outlives the chat, so this is not cosmetic.
     */
    const spy = vi.spyOn(window.history, 'replaceState');
    withUrl('?token=app-signed-jwt');
    await loadHost();
    expect(spy).toHaveBeenCalledWith(null, '', '/');
    spy.mockRestore();
  });

  it('passes closeUrl through when the app names its own scheme', async () => {
    withUrl('?token=app-signed-jwt&closeUrl=yijiapp%3A%2F%2Fclose');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ closeUrl: 'yijiapp://close' });
  });

  it('wins over a stale walk-in handoff left in sessionStorage', async () => {
    // An app arriving with a token means it; a leftover QR session must not
    // open somebody else's chat instead.
    sessionStorage.setItem('yiji.walkInToken', 'old-qr-token');
    withUrl('?token=fresh-app-token');
    await loadHost();
    expect(initSpy.mock.calls[0][0]).toMatchObject({ token: 'fresh-app-token' });
  });

  it('falls through to the phone form when there is no token', async () => {
    vi.stubEnv('DEV', false);
    withUrl('');
    await loadHost();
    expect(location.replace).toHaveBeenCalledWith('/walk-in');
  });
});
