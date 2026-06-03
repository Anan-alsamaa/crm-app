import { SignJWT } from 'jose';
import { YijiChat } from './embed.js';

/**
 * DEV ONLY demo harness. A real host page receives the JWT from the Yiji
 * platform; here we mint one in-browser with the shared dev secret so the
 * widget can be exercised end-to-end locally. Never ship a secret to the client.
 */
const DEV_SECRET = 'dev-yiji-secret';
const GATEWAY_URL = 'http://localhost:8080';

async function mintDevToken(): Promise<string> {
  return new SignJWT({
    vendor_id: 'demo-vendor',
    customer_id: 'demo-customer-1',
    phone: '+966500000001',
    email: 'demo.customer@example.com',
    name: 'Demo Customer',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(DEV_SECRET));
}

void mintDevToken().then((token) => {
  YijiChat.init({ gatewayUrl: GATEWAY_URL, token, locale: 'en' });
});
