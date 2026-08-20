/**
 * Where the e2e suite expects to find each surface.
 *
 * The specs used to hardcode `http://localhost:5173` in a dozen places, which
 * had two consequences. `E2E_BASE_URL` did nothing, because almost nothing read
 * it. And when ANOTHER project's dev server took 5173 — as one had — every
 * agent and admin spec failed against a completely different application's
 * login page, reporting nine broken features when nothing was broken at all.
 *
 * The defaults are the SERVED portals (the nginx container the local stack
 * runs), not the vite dev ports, because those are the ones `check-stack.ps1`
 * guarantees and the ones a demo actually uses. Override per surface to point
 * at a dev server while working on it.
 */
export const AGENT_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:8090').replace(/\/$/, '');
export const ADMIN_URL = (process.env.E2E_ADMIN_URL ?? 'http://localhost:8092').replace(/\/$/, '');
export const WIDGET_URL = (process.env.E2E_WIDGET_URL ?? 'http://localhost:5175').replace(
  /\/$/,
  '',
);
