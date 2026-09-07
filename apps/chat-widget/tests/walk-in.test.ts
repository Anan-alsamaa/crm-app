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
  <button type="button" id="walk-in-lang">العربية</button>
  <h1 id="walk-in-heading">Something wrong with your order?</h1>
  <p id="walk-in-sub">sub</p>
  <form id="walk-in-form">
    <label for="phone" id="walk-in-label">Mobile number</label>
    <input id="phone" dir="ltr" />
    <p id="walk-in-error" hidden></p>
    <button id="walk-in-submit" type="submit">Start chat</button>
  </form>
  <p id="walk-in-foot">foot</p>
`;

let fetchMock: ReturnType<typeof vi.fn>;

async function loadPage(search = '', options: { pinEnglish?: boolean } = {}): Promise<void> {
  document.body.innerHTML = PAGE;
  /*
   * Pin the language unless a case says otherwise. The page is Arabic-first
   * now, and most of these tests read its English words; the language block
   * below passes `pinEnglish: false` to exercise what a real visitor gets.
   */
  if (options.pinEnglish !== false && !localStorage.getItem('yiji.locale')) {
    localStorage.setItem('yiji.locale', 'en');
  }
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
  localStorage.clear();
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
    // The field is prefilled with `05` and the customer types the remaining
    // eight digits, which is the flow the prefix exists to support.
    await loadPage();
    type('0512345678');
    expect(input().value).toBe('0512345678');
  });

  it('takes a FULL number typed over the prefix as the number itself', async () => {
    /*
     * The caret is held after the prefix, so typing one's whole number lands
     * on top of it: `05` + `0500000771`. This used to keep eight digits of
     * that and open a chat for `0505000007`, a stranger who did not exist.
     * Found on staging by a probe doing exactly what a customer would.
     */
    await loadPage();
    type('050500000771');
    expect(input().value).toBe('0500000771');
  });

  it('leaves a genuine 0505… number alone when typed the intended way', async () => {
    await loadPage();
    type('0505000007');
    expect(input().value).toBe('0505000007');
  });

  it('converts a +966 number pasted after the prefix', async () => {
    await loadPage();
    type('05+966 50 000 0771');
    expect(input().value).toBe('0500000771');
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

describe('the page speaks the customer’s language', () => {
  const heading = () => document.getElementById('walk-in-heading') as HTMLElement;
  const lang = () => document.getElementById('walk-in-lang') as HTMLButtonElement;

  /**
   * jsdom reports en-US, which IS a phone asking for English — so a test about
   * the default has to say which languages the phone claims, or it silently
   * asserts the English path and proves nothing about the default.
   */
  const phoneSpeaks = (...languages: string[]) =>
    vi.stubGlobal('navigator', { languages, language: languages[0] });

  it('opens in ARABIC when the phone asks for neither language', async () => {
    // The markup ships English so a page whose script failed still says
    // something; the script rewrites it in the customer's language on load.
    phoneSpeaks('fr-FR');
    await loadPage('', { pinEnglish: false });
    expect(heading().textContent).toBe('هل هناك مشكلة في طلبك؟');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('opens in Arabic when the phone asks for Arabic', async () => {
    phoneSpeaks('ar-SA');
    await loadPage('', { pinEnglish: false });
    expect(heading().textContent).toBe('هل هناك مشكلة في طلبك؟');
  });

  it('follows a phone set to English', async () => {
    phoneSpeaks('en-US');
    await loadPage('', { pinEnglish: false });
    expect(heading().textContent).toBe('Something wrong with your order?');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('switches on one tap, and names the other language in that language', async () => {
    phoneSpeaks('ar-SA');
    await loadPage('', { pinEnglish: false });
    expect(lang().textContent).toBe('English');
    lang().click();
    expect(heading().textContent).toBe('Something wrong with your order?');
    expect(lang().textContent).toBe('العربية');
    // Tagged as the language it is written in, or the browser shapes it and a
    // screen reader pronounces it with the wrong rules.
    expect(lang().lang).toBe('ar');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('remembers the choice, so the chat it hands off to opens the same way', async () => {
    phoneSpeaks('ar-SA');
    await loadPage('', { pinEnglish: false });
    lang().click();
    expect(localStorage.getItem('yiji.locale')).toBe('en');
  });

  it('shows validation errors in the language on screen', async () => {
    phoneSpeaks('ar-SA');
    await loadPage('', { pinEnglish: false });
    type('0501');
    await send();
    expect(error().textContent).toBe('يرجى إدخال رقم الجوال كاملًا — 05 وثمانية أرقام بعدها.');
  });

  it('keeps the number left-to-right even in Arabic', async () => {
    // A phone number is digits in a fixed order; mirroring it makes 0501… read
    // as …1050 on a right-to-left line.
    phoneSpeaks('ar-SA');
    await loadPage('', { pinEnglish: false });
    expect(input().getAttribute('dir') ?? 'ltr').toBe('ltr');
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
  it('posts the CODE, and never a phone number', async () => {
    await loadPage('?c=A7K9F2M4XQ');
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ code: 'A7K9F2M4XQ' });
    expect(body).not.toHaveProperty('phone');
  });

  it('hides the form — the customer was already identified', async () => {
    await loadPage('?c=A7K9F2M4XQ');
    await new Promise((r) => setTimeout(r, 0));
    expect(form().hasAttribute('hidden')).toBe(true);
  });

  it('strips the token from the address bar straight away', async () => {
    // It authenticates a session, and a URL carrying one lands in history, in
    // screenshots, and in the Referer of anything the page later loads.
    const spy = vi.spyOn(window.history, 'replaceState');
    await loadPage('?c=A7K9F2M4XQ');
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith(null, '', '/walk-in.html');
    spy.mockRestore();
  });

  it('hands off to the chat exactly as a typed number does', async () => {
    await loadPage('?c=A7K9F2M4XQ');
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.getItem('yiji.walkInToken')).toBe('walk-in-token');
    expect(location.replace).toHaveBeenCalledWith('/');
  });

  it('puts the form back when the link has expired, rather than stranding them', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ ok: false }) });
    await loadPage('?c=STALE00000');
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
