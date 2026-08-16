/*
 * Runtime configuration. REPLACED PER ENVIRONMENT at deploy time — the bundle
 * itself is identical in staging and production, so the artifact that passed
 * staging is the artifact that ships.
 *
 * Left empty here: local development falls through to the build-time values in
 * .env.local, and then to localhost. A deployed container writes this file with
 * its own URLs before nginx starts.
 *
 *   window.__SARA_CONFIG__ = {
 *     DIRECTUS_URL: 'https://api.example.com',
 *     SOCKET_URL: 'https://ws.example.com',
 *     AI_GATEWAY_URL: 'https://ai.example.com',
 *   };
 */
window.__SARA_CONFIG__ = {};
