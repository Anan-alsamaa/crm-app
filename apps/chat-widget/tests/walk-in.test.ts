import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * THE STORE QR PAGE.
 *
 * A customer standing in a branch scans a printed code, types the number they
 * order with, and is dropped into the chat. It is the only surface in the
 * product a stranger can reach with no account and no app, and it had no tests
 * at all — including the phone handling, which is the one thing between a real
 * visitor and a session that silently belongs to somebody else.
 *
 * The module binds to the DOM and runs on import, so each test builds the page
 * first and imports with a fresh module registry.
 */

const PAGE = `
  <form id="walk-in-form">
    <input id="phone" />
    <p id="walk-in-error" hidden></p>
    <button id="walk-in-submit" type="submit">Start chat</button>
  </form>
`;

let fetchMock: ReturnType<typeof vi.fn>;

async function loadPage(search = ''): Promise<void> {
  document.body.innerHTML = PAGE;
  /*
   * The page reads `?t=` on load, so the URL is part of the fixture. jsdom
   * refuses a real navigation, so `location` is stubbed — and the stub has to
   * carry `search` and `pathname`, not just `replace`: the page reads the first
   * to find a link token and the second to strip it out again.
   */
  vi.stubGlobal('location', {
    replace: vi.fn(),
    href: `http://localhost/walk-in.html${search}`,
    pathname: '/walk-in.html',
    search,
  });
  vi.resetModules();
  await import('../src/walk-in.js');
}

const input = () => document.getElementById('phone') as HTMLInputElement;
const form = () => document.getElementById('walk-in-form') as HTMLFormElement;
const error = () => document.getElementById('walk-in-error') as HTMLElement;
const submit = () => document.getElementById('walk-in-submit') as HTMLButtonElement;

function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

/** Submit and let the fetch promise chain settle. */
async function send(): Promise<void> {
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, token: 'walk-in-token' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  // A default for the tests that never call loadPage with a query string;
  // loadPage replaces it with one carrying the right search.
  vi.stubGlobal('location', {
    replace: vi.fn(),
    href: 'http://localhost/walk-in.html',
    pathname: '/walk-in.html',
    search: '',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('walk-in phone field', () => {
  it('starts at 05, because every Saudi mobile does', async () => {
    // Eight wasted taps at a counter is eight chances to give up.
    await loadPage();
    expect(input().value).toBe('05');
  });

  it('converts a pasted +966 number rather than treating it as local digits', async () => {
    /*
     * `+966 5X…` and `05X…` are the same number written two ways. Reading the
     * country code as the start of a local number produces `0596650…`, which
     * matches no contact and opens a session for a customer who does not exist.
     */
    await loadPage();
    type('+966501234567');
    expect(input().value).toBe('0501234567');
  });

  it('puts the prefix back when the customer deletes it', async () => {
    // Letting them delete it produces a number the gateway cannot match.
    await loadPage();
    type('');
    expect(input().value).toBe('05');
  });

  it('treats digits after the prefix as the REST of the number', async () => {
    /*
     * The field is prefilled with `05` and the customer types the remaining
     * eight digits, which is the flow the prefix exists to support.
     *
     * Documented rather than merely observed, because it is also the sharp
     * edge here: everything after `05` is taken at face value, so a full local
     * number pasted INTO the prefilled field reads as `05` + those digits and
     * silently produces a different number. Worth a paste handler; not changed
     * here, because nobody has reported it and guessing at the fix would be a
     * second bug.
     */
    await loadPage();
    type('0512345678');
    expect(input().value).toBe('0512345678');
  });

  it('never lets the number grow past 05 + eight digits', async () => {
    await loadPage();
    type('05012345678999');
    expect(input().value).toBe('0501234567');
  });

  it('drops anything that is not a digit', async () => {
    await loadPage();
    type('05-01 23 45 67');
    expect(input().value).toBe('0501234567');
  });
});

describe('walk-in submit', () => {
  it('refuses a short number at the field, not with a 400 from the gateway', async () => {
    await loadPage();
    type('0501');
    await send();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toMatch(/full mobile number/i);
  });

  it('asks the GATEWAY for the token — this page can never mint one', async () => {
    // A page that could sign its own token could mint one for anybody.
    await loadPage();
    type('0501234567');
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/walk-in\/session$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ phone: '0501234567' });
  });

  it('hands the token over in sessionStorage, never in the URL', async () => {
    // A URL carrying a customer token lands in history and in referrers.
    await loadPage();
    type('0501234567');
    await send();
    expect(sessionStorage.getItem('yiji.walkInToken')).toBe('walk-in-token');
    expect(location.replace).toHaveBeenCalledWith('/');
    expect(String((location.replace as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).not.toContain(
      'walk-in-token',
    );
  });

  it('says so plainly when the gateway rate-limits the counter', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ ok: false }),
    });
    await loadPage();
    type('0501234567');
    await send();
    expect(error().textContent).toMatch(/too many attempts/i);
    // Re-enabled, or the customer cannot try again after waiting.
    expect(submit().disabled).toBe(false);
  });

  it('recovers from a refused session without stranding the button', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ ok: false }) });
    await loadPage();
    type('0501234567');
    await send();
    expect(error().textContent).toMatch(/could not start the chat/i);
    expect(submit().disabled).toBe(false);
    expect(sessionStorage.getItem('yiji.walkInToken')).toBeNull();
  });

  it('survives a dead network — the shop wifi, in practice', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await loadPage();
    type('0501234567');
    await send();
    expect(error().textContent).toMatch(/could not reach support/i);
    expect(submit().disabled).toBe(false);
  });
});

describe('a personal link starts the chat without the form', () => {
  /*
   * `?t=<signed token>` — never `?phone=`. Saudi mobiles are `05` plus eight
   * digits, so an editable link means anyone holding one can walk the number
   * space and open any customer's chat from a browser bar. The token cannot be
   * edited into somebody else's number because the signature would not survive
   * it, and the number never appears in the URL at all.
   */
  it('posts the TOKEN, and never a phone number', async () => {
    await loadPage('?t=signed-link-token');
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ token: 'signed-link-token' });
    expect(body).not.toHaveProperty('phone');
  });

  it('hides the form — the customer was already identified', async () => {
    await loadPage('?t=signed-link-token');
    await new Promise((r) => setTimeout(r, 0));
    expect(form().hasAttribute('hidden')).toBe(true);
  });

  it('strips the token from the address bar straight away', async () => {
    // It authenticates a session, and a URL carrying one lands in history, in
    // screenshots, and in the Referer of anything the page later loads.
    const spy = vi.spyOn(window.history, 'replaceState');
    await loadPage('?t=signed-link-token');
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith(null, '', '/walk-in.html');
    spy.mockRestore();
  });

  it('hands off to the chat exactly as a typed number does', async () => {
    await loadPage('?t=signed-link-token');
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.getItem('yiji.walkInToken')).toBe('walk-in-token');
    expect(location.replace).toHaveBeenCalledWith('/');
  });

  it('puts the form back when the link has expired, rather than stranding them', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false }) });
    await loadPage('?t=stale');
    await new Promise((r) => setTimeout(r, 0));
    expect(error().textContent).toMatch(/expired/i);
    expect(form().hasAttribute('hidden')).toBe(false);
    expect(submit().disabled).toBe(false);
  });

  it('asks nothing of the gateway when there is no link', async () => {
    await loadPage();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(form().hasAttribute('hidden')).toBe(false);
  });
});
