/*
 * Why is this customer token being refused?
 *
 *   node scripts/check-customer-token.mjs <token> [staging|prod]
 *
 * Written after the Yiji app spent a day showing "Connecting…" for ever. The
 * gateway knew the answer the whole time — `token invalid: invalid signature`,
 * twelve times in the production log — but finding that meant knowing which log
 * group to read and what to grep for. Answering "is this token good, and if not
 * why" should not require AWS access.
 *
 * READ-ONLY: verifies locally against the environment's secret and prints what
 * the gateway would say. It connects to nothing and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/* Resolved from the GATEWAY, which owns this dependency and is the thing whose
   verdict we are reproducing — so this script can never drift onto a different
   jsonwebtoken than the service actually verifies with. */
const require_ = createRequire(
  new URL('../services/socket-gateway/package.json', import.meta.url),
);
const jwt = require_('jsonwebtoken');

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const token = process.argv[2];
const envName = (process.argv[3] ?? 'prod').toLowerCase();
if (!token || !['staging', 'prod'].includes(envName)) {
  console.error('usage: node scripts/check-customer-token.mjs <token> [staging|prod]');
  process.exit(2);
}

const file = envName === 'prod' ? '.env.prod.aws' : '.env.staging';
const secret = (() => {
  const line = readFileSync(`${ROOT}/${file}`, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('YIJI_JWT_SECRET='));
  return line ? line.slice('YIJI_JWT_SECRET='.length).trim() : '';
})();
if (!secret) {
  console.error(`No YIJI_JWT_SECRET in ${file}.`);
  process.exit(1);
}

const fail = (why, fix) => {
  console.log(`\n  REFUSED — the gateway would say: "${why}"`);
  console.log(`  FIX: ${fix}\n`);
  process.exit(1);
};

console.log(`\nChecking this token against ${envName.toUpperCase()}.`);

/* Decode WITHOUT verifying first, so a signature failure can still report who
   the token claims to be — which is what identifies whose app sent it. */
const decoded = jwt.decode(token, { complete: true });
if (!decoded) {
  fail(
    'token invalid: jwt malformed',
    'This is not a JWT at all. Check the app is putting the token in ?token= and not, say, a customer id or a URL-encoded blob.',
  );
}

console.log(`  algorithm : ${decoded.header.alg}`);
const c = decoded.payload;
console.log(`  vendor_id : ${c.vendor_id ?? '(absent — defaults to 1)'}`);
console.log(`  customer  : ${c.customer_id ?? '(absent)'}`);
console.log(`  phone     : ${c.phone ?? '(absent)'}`);
if (c.exp) {
  const when = new Date(c.exp * 1000);
  const mins = Math.round((when - Date.now()) / 60000);
  console.log(`  expires   : ${when.toISOString().slice(0, 19)}Z (${mins} min from now)`);
}

if (decoded.header.alg !== 'HS256') {
  fail(
    `token invalid: algorithm ${decoded.header.alg} is not accepted`,
    'Sign with HS256. The gateway accepts nothing else.',
  );
}

try {
  jwt.verify(token, secret, { algorithms: ['HS256'] });
} catch (err) {
  const m = String(err?.message ?? err);
  if (/signature/i.test(m)) {
    fail(
      'token invalid: invalid signature',
      `The token is well formed but signed with a DIFFERENT secret than ${envName} holds.\n` +
        `       Staging and production deliberately use different YIJI_JWT_SECRETs, so a token minted\n` +
        `       for one is always refused by the other. Confirm the app signs with ${envName}'s secret\n` +
        `       AND opens ${envName}'s widget URL — mixing the two produces exactly this.`,
    );
  }
  if (/expired/i.test(m)) {
    fail(
      'token invalid: jwt expired',
      'Mint the token when the customer opens the chat, not at app start. The gateway checks exp.',
    );
  }
  fail(`token invalid: ${m}`, 'See the message above.');
}

if (!String(c.phone ?? '').trim()) {
  fail(
    'token must include a phone number',
    'Add a `phone` claim in 05XXXXXXXX form. It is the only mandatory contact field.',
  );
}

console.log(`\n  VALID for ${envName}. If the chat still fails, the token is not the cause —`);
console.log('  check the gateway log for "connection rejected" or reopen with the browser console open.\n');
