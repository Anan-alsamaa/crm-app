import { SignJWT } from 'jose';
import { YijiChat } from './embed.js';

/**
 * DEV ONLY demo harness.
 *
 * A real host page receives the JWT from the Yiji platform; here we mint
 * one in-browser with the shared dev secret so the widget can be exercised
 * end-to-end locally. Never ship a secret to the client.
 *
 * The customer identity (vendor_id, customer_id, phone, email, name) is
 * the contract between the host page and the gateway. It is:
 *   1. Read here from URL query params (so the demo can be tested with
 *      arbitrary identities — `?vendor_id=X&customer_id=Y&phone=...`).
 *   2. Falls back to a fixed demo identity matching the seed data.
 *   3. Encoded into the JWT we sign with the dev secret.
 *   4. The gateway verifies + upserts a contact keyed per-vendor by
 *      phone OR email. See `services/socket-gateway/src/directus.ts`.
 *
 * The "Identity received" card below the launcher renders the resolved
 * identity so it's visible the data made it through. Useful when
 * QA-ing the integration on a phone or in stage.
 */
// Dev/demo only: the host page normally receives a platform-signed JWT. Here we
// mint one locally with a shared secret. Both are configurable at build time so
// a production-like run can align them with the gateway (YIJI_JWT_SECRET) and
// the real gateway URL.
const DEV_SECRET =
  (import.meta.env.VITE_WIDGET_JWT_SECRET as string | undefined) ?? 'dev-yiji-secret';
const GATEWAY_URL =
  (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? 'http://localhost:8080';

interface CustomerIdentity {
  vendor_id: string;
  customer_id: string;
  phone?: string;
  email?: string;
  name?: string;
}

// Phone is the ONLY mandatory identifier (the gateway enforces this). By default
// the demo is a phone-ONLY customer — no name, no email — so the agent inbox shows
// the phone number as the contact's display name until an agent saves a real name.
// Name and email are optional: pass them via URL params to test the "present" case,
// e.g. ?name=Ahmed&email=ahmed@example.com (they're then forwarded to the CRM).
const DEFAULT_IDENTITY: CustomerIdentity = {
  vendor_id: 'demo-vendor',
  customer_id: 'demo-customer-phone',
  phone: '+966555123456',
};

function resolveIdentity(): CustomerIdentity {
  const url = new URL(window.location.href);
  const q = url.searchParams;
  const get = (k: string): string | undefined => q.get(k) ?? undefined;
  return {
    vendor_id: get('vendor_id') ?? DEFAULT_IDENTITY.vendor_id,
    customer_id: get('customer_id') ?? DEFAULT_IDENTITY.customer_id,
    phone: get('phone') ?? DEFAULT_IDENTITY.phone,
    email: get('email') ?? DEFAULT_IDENTITY.email,
    name: get('name') ?? DEFAULT_IDENTITY.name,
  };
}

async function mintDevToken(identity: CustomerIdentity): Promise<string> {
  return new SignJWT({ ...identity })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(DEV_SECRET));
}

/**
 * Render a small card showing the identity we just minted into the JWT.
 * Lets a QA / stage tester confirm at a glance that the host page passed
 * the customer data through.
 */
function renderIdentityCard(identity: CustomerIdentity): void {
  const card = document.createElement('div');
  card.className = 'identity-card';
  card.innerHTML = `
    <div class="identity-card-head">
      <span class="identity-card-pill" aria-hidden></span>
      <span>Identity received from host page</span>
    </div>
    <dl>
      <dt>vendor_id</dt><dd>${escapeHtml(identity.vendor_id)}</dd>
      <dt>customer_id</dt><dd>${escapeHtml(identity.customer_id)}</dd>
      ${identity.name ? `<dt>name</dt><dd>${escapeHtml(identity.name)}</dd>` : ''}
      ${identity.email ? `<dt>email</dt><dd>${escapeHtml(identity.email)}</dd>` : ''}
      ${identity.phone ? `<dt>phone</dt><dd>${escapeHtml(identity.phone)}</dd>` : ''}
    </dl>
    <p class="identity-card-foot">
      Override any field with a URL param —
      e.g. <code>?phone=+9665…&amp;name=Ahmed</code>
    </p>
  `;
  document.body.appendChild(card);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const identity = resolveIdentity();
// Identity card is dev-only — surface it via `?debug=1` so the customer-facing
// page stays clean. Useful for verifying the JWT payload chain.
if (new URL(window.location.href).searchParams.get('debug') === '1') {
  renderIdentityCard(identity);
}
void mintDevToken(identity).then((token) => {
  YijiChat.init({ gatewayUrl: GATEWAY_URL, token, locale: 'en' });
});
