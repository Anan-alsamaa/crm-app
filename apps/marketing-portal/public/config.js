/*
 * Runtime configuration. REPLACED PER ENVIRONMENT at deploy time — the bundle
 * itself is identical in staging and production, so the artifact that passed
 * staging is the artifact that ships.
 *
 *   window.__SARA_CONFIG__ = {
 *     DIRECTUS_URL: 'https://api.example.com',
 *     SOCKET_URL: 'https://ws.example.com',
 *     AI_GATEWAY_URL: 'https://ai.example.com',
 *   };
 *
 * Left empty ON LOCALHOST: local development falls through to the build-time
 * values in .env.local, and then to loopback. A deployed container overwrites
 * this file with its own URLs before nginx starts.
 *
 * OFF localhost it is NOT empty, and that is the whole point of this file
 * having any logic in it at all:
 *
 * The portal resolves its Directus URL through `onPageHost`, which moves a
 * loopback address onto whatever host the page was opened on. Locally that is
 * exactly right. Opened through a tunnel or on a LAN address it produces
 * `https://<that-host>:8055` — a port nothing is listening on there — so the
 * page loads perfectly and every single request fails. It reads as "login is
 * broken" when the truth is "there is no API at that address".
 *
 * Same-origin `/directus` is the answer: nginx proxies that path to Directus
 * (see deploy/nginx.local.conf), so there is one origin, no second tunnel to
 * buy, no CORS, and a first-party refresh-token cookie.
 *
 * The localhost check keeps `vite dev` and `localhost:8092` on the path they
 * already use, where no such proxy exists.
 */
window.__SARA_CONFIG__ = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
  window.location.hostname,
)
  ? {}
  : { DIRECTUS_URL: window.location.origin + '/directus' };
