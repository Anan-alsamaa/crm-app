import { YijiChat } from './embed.js';
import { applyDocumentLocale, resolveLocale, storeLocale } from './locale.js';

/**
 * The chat page: the ONE surface every customer lands on.
 *
 * Two doors, one room. A customer inside the Yiji app gets this widget from
 * the app's own page, which embeds `yiji-chat-widget.js` and hands
 * `YijiChat.init` a token the platform signed (see embed.ts). A customer with
 * no app, standing in a branch, scans a QR code, types their number on
 * `walk-in.html`, and is sent HERE with a token the GATEWAY signed. Same
 * bundle, same gateway, same contact keyed by phone, and for a customer the
 * app has identified, the same conversation either way.
 *
 * So this page does exactly one of three things:
 *
 *   1. a walk-in handoff is waiting: open the chat with it;
 *   2. nothing is waiting and this is the dev server: run the demo harness,
 *      which mints a token with the shared DEV secret (demo.ts, dev-only by
 *      construction: it is imported here inside a DEV-only branch, and the
 *      published build refuses to emit it, see vite.pages.config.ts);
 *   3. nothing is waiting on a published host: send the visitor to the phone
 *      form. Opened "normally", from a link or a typed address, the page is
 *      the walk-in flow.
 *
 * The page never mints. The previous host page did, for the local harness,
 * and was stripped from every deploy for it; a page that can sign a customer
 * token can sign one for anybody.
 */

/**
 * Where the widget connects. Baked in at build time for a published host,
 * where the pages live on a static bucket and the gateway on the API host.
 * Empty on the dev server means the local gateway; empty on a published host
 * means this page's own origin, for a deployment that proxies `/socket.io`.
 */
const GATEWAY_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? 'http://localhost:8080' : window.location.origin);
/*
 * The clean path, not `/walk-in.html`.
 *
 * The deploy uploads the QR page under BOTH keys, and they serve the same
 * bytes — but this is the address a customer sees after being redirected, and
 * the one that goes on a printed code in a branch. `.html` in it is a
 * filename leaking into a poster.
 *
 * On the dev server there is no such key: Vite serves files, so the extension
 * is required there.
 */
const WALK_IN_URL = import.meta.env.DEV ? '/walk-in.html' : '/walk-in';

/**
 * Where the close button sends the customer, when the app has not said.
 *
 * The Yiji app opens this page in a web view and registers a scheme; visiting
 * it hands control back so the customer never learns they left the app. OURS
 * to configure rather than theirs to pass — it is the same for every customer,
 * and a constant an integrator has to remember is a constant they can mistype.
 * In an ordinary browser the scheme does not resolve and the widget collapses
 * instead, so a wrong value is never a dead end.
 */
const CLOSE_URL = (import.meta.env.VITE_WALK_IN_CLOSE_URL as string | undefined) ?? 'closeapp://';

/*
 * The handoff from the QR page, if there is one.
 *
 * sessionStorage rather than a query string: the token authenticates a
 * customer, and a URL carrying one ends up in history, in referrers, and in
 * any screenshot of the address bar. Same origin, so the stash survives the
 * redirect and nothing else can read it.
 *
 * Read once and REMOVED, so a refresh or a back-navigation later cannot
 * resurrect a session the customer thought they had closed. (Their THREAD
 * survives a refresh regardless; see resume.ts. What does not survive is the
 * token, and the phone form is one tap away.)
 */
const WALK_IN_TOKEN_KEY = 'yiji.walkInToken';
const WALK_IN_CLOSE_KEY = 'yiji.walkInCloseUrl';

/**
 * Is this JWT past its `exp`?
 *
 * Unverified on purpose — see the call site. A token we cannot parse is treated
 * as expired: something is wrong with it, and sending the customer to the phone
 * form is the recoverable answer.
 *
 * Thirty seconds of slack, because a token that expires while the page is
 * loading should not open a chat that dies a moment later.
 */
export function isExpired(token: string, now = Date.now()): boolean {
  try {
    const part = token.split('.')[1];
    if (!part) return true;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const { exp } = JSON.parse(atob(padded)) as { exp?: number };
    // No `exp` at all: not ours to judge — let the gateway decide.
    if (typeof exp !== 'number') return false;
    return exp * 1000 <= now + 30_000;
  } catch {
    return true;
  }
}

function takeWalkInSession(): { token: string; closeUrl?: string; canRemint?: false } | null {
  try {
    const token = sessionStorage.getItem(WALK_IN_TOKEN_KEY);
    if (!token) return null;
    const closeUrl = sessionStorage.getItem(WALK_IN_CLOSE_KEY) ?? undefined;
    /*
     * EXPIRED IS AS GOOD AS ABSENT.
     *
     * A walk-in token lasts two hours. Keeping it across reloads (below) means
     * a stale one is still sitting there the next morning — and the page then
     * hands it to the gateway, which refuses it, and the customer watches
     * "Reconnecting…" become "We could not start this chat. Please reopen it
     * from the app, or call us." on a page they reached by scanning a QR code
     * with no app involved (owner, 2026-09-16, screenshots).
     *
     * Treated as no session at all, so the customer is sent back to the phone
     * form and gets a fresh one. Read WITHOUT verifying the signature: this is
     * a client deciding whether to bother trying, not an authority deciding
     * whether to trust — the gateway still verifies properly, and a forged
     * `exp` only buys somebody a rejection they would have got anyway.
     */
    if (isExpired(token)) {
      clearWalkInSession();
      return null;
    }
    /*
     * KEPT, NOT CONSUMED.
     *
     * This deleted the token as it read it, so the chat page worked exactly
     * ONCE. Anything that re-ran the page — a pull-to-refresh, a web view
     * restoring after the app was backgrounded, an OS reclaiming memory — then
     * found nothing and redirected to `/walk-in`, which sends the customer
     * back to the chat, which finds nothing... The customer sees the page
     * flickering between the phone form and the chat (owner, 2026-09-16).
     *
     * A one-shot read was meant to stop a closed session being resurrected by
     * a Back navigation. It is the wrong tool: the token is short-lived and
     * scoped to this tab's `sessionStorage`, which the browser discards when
     * the tab closes — so the session already ends when the customer leaves.
     * Closing the chat clears it explicitly (see `clearWalkInSession`), which
     * is the case that actually needed handling.
     */
    return { token, closeUrl };
  } catch {
    // Private mode / storage disabled: no handoff to take.
    return null;
  }
}

/**
 * End the walk-in session deliberately — the customer closed the chat.
 *
 * This is what the one-shot read above was reaching for, done at the moment it
 * actually means something rather than on every page load.
 */
export function clearWalkInSession(): void {
  try {
    sessionStorage.removeItem(WALK_IN_TOKEN_KEY);
    sessionStorage.removeItem(WALK_IN_CLOSE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/**
 * A token handed over in the URL — how the Yiji app opens this page.
 *
 * The app cannot easily run a script tag and call `YijiChat.init`, so it
 * navigates a web view to `…/?token=<JWT>` instead. One URL, no JavaScript on
 * their side, and the customer is never asked for a phone number they have
 * already given the app.
 *
 * The token is REMOVED from the address bar immediately, before the widget
 * even mounts. A URL carrying a customer's session lands in history, in the
 * `Referer` of anything the page later loads, and in any screenshot — and a
 * web view's history outlives the chat. Same treatment the QR page gives its
 * `?c=` code.
 *
 * The close scheme is OURS to know, not theirs to send. It is the same for
 * every customer, so putting it in the URL made the integrator carry a
 * constant that never varies — and a mistyped one strands people on a blank
 * page inside the app. `VITE_WALK_IN_CLOSE_URL` already holds it for the QR
 * flow; the same value serves here. A `?closeUrl=` is still honoured, so an
 * app whose scheme differs can override without waiting for a deploy.
 */
function takeUrlSession(): { token: string; closeUrl?: string; canRemint: true } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return null;
    const closeUrl = params.get('closeUrl')?.trim() || CLOSE_URL;
    history.replaceState(null, '', window.location.pathname);
    /* A reload re-reads this URL, so the app can hand us a fresh token. */
    return { token, canRemint: true, ...(closeUrl ? { closeUrl } : {}) };
  } catch {
    return null;
  }
}

/* The app's language wins over the handset and over a remembered tap — read
   BEFORE the token is stripped from the address bar, because that strip takes
   `?lang=` with it. See locale.ts for the full order. */
const locale = resolveLocale(window.location.search);
applyDocumentLocale(locale);

// The URL first: an app that just navigated here with a token means it, and
// a stale walk-in handoff in sessionStorage must not win over a fresh one.
const session = takeUrlSession() ?? takeWalkInSession();
if (session) {
  // Signed by the gateway; nothing is minted here. autoOpen: this page IS the
  // chat, so no launcher click stands between the customer and it.
  YijiChat.init({
    gatewayUrl: GATEWAY_URL,
    token: session.token,
    locale,
    /* Remember the choice AND re-dress the document.
       The widget re-renders itself in the new language, but `<html lang>` and
       `dir` are outside it and were left at whatever the page loaded with — so
       after a switch the page still announced the wrong language to screen
       readers and to anything styling on `[dir]`. Storing alone was never
       enough. */
    onLocaleChange: (next) => {
      storeLocale(next);
      applyDocumentLocale(next);
    },
    autoOpen: true,
    /* Only the app-token path survives a reload — see ConnectOptions. */
    canRemintToken: session.canRemint === true,
    /* The customer pressed close: end the walk-in session deliberately, which
       is what the old consume-on-read was reaching for. */
    onClose: clearWalkInSession,
    ...(session.closeUrl ? { closeUrl: session.closeUrl } : {}),
  });
} else if (import.meta.env.DEV) {
  void import('./demo.js');
} else {
  /*
   * NO SESSION — the phone form is where this page belongs.
   *
   * This cannot loop, and I checked rather than assumed: `/walk-in` only
   * submits on its own when it carries a `?c=` link code. Reached plainly it
   * renders the form and WAITS, so it never hands back an empty session. The
   * flicker came from the token being deleted on read (fixed above), not from
   * the redirect.
   *
   * A bounce counter briefly guarded this and made things worse: on its second
   * lap it did nothing, leaving the customer on a chat page with no session
   * that said "could not start this chat — reopen it from the app" to somebody
   * who had scanned a QR code in a branch. A guard that strands people is
   * worse than the loop it was written for.
   */
  window.location.replace(WALK_IN_URL);
}
