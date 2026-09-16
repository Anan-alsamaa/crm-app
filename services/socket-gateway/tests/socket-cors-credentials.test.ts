import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * A CREDENTIALED CORS RESPONSE CANNOT USE `*`.
 *
 * Stickiness for the polling transport rides an `AWSALB` cookie. A browser
 * only stores and returns that cookie cross-origin when the response carries
 * `access-control-allow-credentials: true` AND names a concrete origin — a
 * wildcard makes it refuse both, silently.
 *
 * The gateway answered `access-control-allow-origin: *` with no credentials
 * header, so with two tasks every poll after the handshake was balanced afresh
 * and the wrong instance answered HTTP 400 "Session ID unknown".
 *
 * Asserted against the source: the server is constructed inside `start()`
 * behind Redis, Directus and a queue producer, so mocking all of that to read
 * one option object would test the mocks. This fails the moment the pairing is
 * broken, which is the regression worth catching.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

describe('socket.io CORS', () => {
  it('allows credentials, so the stickiness cookie is kept', () => {
    expect(SOURCE).toContain('credentials: true');
  });

  it('reflects the origin instead of answering with a bare wildcard', () => {
    // `origin: true` makes socket.io echo the caller's origin, which is what
    // makes a credentialed response legal.
    expect(SOURCE).toContain("widgetCorsOrigin === '*' ? true : widgetCorsOrigin");
  });
});
