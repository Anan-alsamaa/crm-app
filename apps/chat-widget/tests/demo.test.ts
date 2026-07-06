import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * demo.ts is the DEV demo harness. It has no exports: importing it runs the
 * whole pipeline (resolveIdentity from the URL -> optional identity card ->
 * mintDevToken via `jose` -> YijiChat.init). We test that observable behaviour
 * by mocking the two side-effecting dependencies and driving the URL, then
 * importing the module fresh per case.
 */

// --- Mock the embed entry so importing demo.ts does not mount a real widget. ---
const initSpy = vi.fn();
vi.mock('../src/embed.js', () => ({
  YijiChat: { init: (...args: unknown[]) => initSpy(...args) },
}));

// --- Mock `jose` so SignJWT does no real crypto and we can inspect the payload. ---
type JosePayload = Record<string, unknown>;
const signSpy = vi.fn();
vi.mock('jose', () => {
  class SignJWT {
    constructor(private readonly payload: JosePayload) {}
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign(secret: Uint8Array): Promise<string> {
      signSpy(this.payload, secret);
      // Deterministic fake token that encodes the payload for assertions.
      return `signed.${JSON.stringify(this.payload)}`;
    }
  }
  return { SignJWT };
});

/** Point window.location at an arbitrary URL for the next import. */
function setLocation(url: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: new URL(url) as unknown as Location,
  });
}

/** Import demo.ts fresh (its top-level code re-runs) and wait for the mint promise. */
async function loadDemo(): Promise<void> {
  vi.resetModules();
  await import('../src/demo.js');
  // The module fires mintDevToken().then(init); flush the microtask queue so the
  // init call has happened before we assert.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  initSpy.mockReset();
  signSpy.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.resetModules();
});

describe('demo.ts: resolveIdentity via YijiChat.init token', () => {
  it('uses the default demo identity when no query params are set', async () => {
    setLocation('http://localhost:5173/');
    await loadDemo();

    expect(initSpy).toHaveBeenCalledTimes(1);
    const opts = initSpy.mock.calls[0][0] as {
      gatewayUrl: string;
      token: string;
      locale: string;
      autoOpen: boolean;
    };
    expect(opts.locale).toBe('en');
    expect(opts.autoOpen).toBe(true);
    expect(opts.gatewayUrl).toBe('http://localhost:8080');

    const payload = JSON.parse(opts.token.replace('signed.', '')) as Record<string, unknown>;
    expect(payload.vendor_id).toBe('demo-vendor');
    expect(payload.phone).toBe('+966555123456');
    // No customer_id param, but a phone default exists -> derived id.
    expect(payload.customer_id).toBe('cust-966555123456');
    expect(payload.email).toBeUndefined();
    expect(payload.name).toBeUndefined();
  });

  it('reads all identity fields from query params', async () => {
    setLocation(
      'http://localhost:5173/?vendor_id=v1&customer_id=c1&phone=%2B15551234567&email=a@b.com&name=Ahmed',
    );
    await loadDemo();

    const opts = initSpy.mock.calls[0][0] as { token: string };
    const payload = JSON.parse(opts.token.replace('signed.', '')) as Record<string, unknown>;
    expect(payload.vendor_id).toBe('v1');
    expect(payload.customer_id).toBe('c1');
    expect(payload.phone).toBe('+15551234567');
    expect(payload.email).toBe('a@b.com');
    expect(payload.name).toBe('Ahmed');
  });

  it('derives customer_id from a phone-only identity (strips non-digits)', async () => {
    setLocation('http://localhost:5173/?phone=%2B1%20(555)%20987-6543');
    await loadDemo();

    const opts = initSpy.mock.calls[0][0] as { token: string };
    const payload = JSON.parse(opts.token.replace('signed.', '')) as Record<string, unknown>;
    expect(payload.customer_id).toBe('cust-15559876543');
    expect(payload.phone).toBe('+1 (555) 987-6543');
  });

  it('prefers an explicit customer_id over the phone-derived one', async () => {
    setLocation('http://localhost:5173/?phone=%2B999&customer_id=explicit-id');
    await loadDemo();

    const opts = initSpy.mock.calls[0][0] as { token: string };
    const payload = JSON.parse(opts.token.replace('signed.', '')) as Record<string, unknown>;
    expect(payload.customer_id).toBe('explicit-id');
  });

  it('signs the JWT with a secret and the resolved payload', async () => {
    setLocation('http://localhost:5173/?vendor_id=vX');
    await loadDemo();

    expect(signSpy).toHaveBeenCalledTimes(1);
    const [payload, secret] = signSpy.mock.calls[0] as [Record<string, unknown>, Uint8Array];
    expect(payload.vendor_id).toBe('vX');
    // secret crosses the vi.mock module realm, so a cross-realm instanceof is
    // unreliable; assert by constructor name and that it encodes bytes instead.
    expect(secret?.constructor?.name).toBe('Uint8Array');
    expect(secret.byteLength).toBeGreaterThan(0);
  });
});

describe('demo.ts: identity card (debug=1)', () => {
  it('does not render the identity card without ?debug=1', async () => {
    setLocation('http://localhost:5173/?vendor_id=v1');
    await loadDemo();
    expect(document.querySelector('.identity-card')).toBeNull();
  });

  it('renders the identity card when ?debug=1 is set', async () => {
    setLocation('http://localhost:5173/?debug=1&vendor_id=v1&customer_id=c1');
    await loadDemo();

    const card = document.querySelector('.identity-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Identity received from host page');
    expect(card?.textContent).toContain('v1');
    expect(card?.textContent).toContain('c1');
  });

  it('omits optional rows (name/email) when absent but shows phone', async () => {
    setLocation('http://localhost:5173/?debug=1');
    await loadDemo();

    const card = document.querySelector('.identity-card');
    const dts = Array.from(card?.querySelectorAll('dt') ?? []).map((d) => d.textContent);
    expect(dts).toContain('vendor_id');
    expect(dts).toContain('customer_id');
    expect(dts).toContain('phone');
    expect(dts).not.toContain('name');
    expect(dts).not.toContain('email');
  });

  it('renders optional name/email rows when supplied', async () => {
    setLocation('http://localhost:5173/?debug=1&name=Sara&email=sara@x.com');
    await loadDemo();

    const card = document.querySelector('.identity-card');
    const dts = Array.from(card?.querySelectorAll('dt') ?? []).map((d) => d.textContent);
    expect(dts).toContain('name');
    expect(dts).toContain('email');
    expect(card?.textContent).toContain('Sara');
    expect(card?.textContent).toContain('sara@x.com');
  });

  it('escapes HTML in identity fields to avoid injection in the card', async () => {
    setLocation(
      'http://localhost:5173/?debug=1&vendor_id=' +
        encodeURIComponent('<script>"&</script>') +
        '&name=' +
        encodeURIComponent('<b>x</b>'),
    );
    await loadDemo();

    const card = document.querySelector('.identity-card');
    // The dangerous markup must not become real elements inside the card.
    expect(card?.querySelector('script')).toBeNull();
    expect(card?.querySelector('b')).toBeNull();
    // The angle brackets and ampersand were escaped, so they survive as entities
    // in the serialized HTML (jsdom re-serializes the escaped text safely).
    expect(card?.innerHTML).toContain('&lt;script&gt;');
    expect(card?.innerHTML).toContain('&amp;');
    // escapeHtml turns `"` into `&quot;`, but text-node serialization renders it
    // back to a literal quote; assert the quote made it through as text.
    expect(card?.textContent).toContain('"');
  });
});
