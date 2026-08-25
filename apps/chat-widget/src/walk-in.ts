/**
 * The store QR page.
 *
 * A customer standing in a branch scans a printed code, lands here, types the
 * phone number they order with, and is dropped straight into the chat. It is
 * the same widget and the same gateway the in-app chat uses — only the way the
 * session is opened differs.
 *
 * WHY A PHONE NUMBER AND NOTHING ELSE. This person may not be a Yiji customer
 * at all: they walked into a shop. Asking them to install an app or make an
 * account to complain about a meal they have already eaten is how a complaint
 * turns into a bad review instead. The phone number is the one thing they
 * certainly have, and it is what every part of the CRM already keys a contact
 * on.
 *
 * WHY THERE IS NO CODE TO TYPE BACK. The number is not verified, and that is a
 * decision rather than an oversight. An SMS round-trip at a counter costs 20-60
 * seconds and fails on a weak signal exactly when the customer is already
 * annoyed. What makes it safe enough is that the session is contained: the
 * gateway gives an unverified visitor a conversation of its own and replays no
 * history, so a guessed number cannot open somebody else's chat, and the
 * conversation opens with an internal note telling the agent the number was
 * never proven. Compensation is not self-service — an agent raises it and a
 * supervisor approves it — so the unverified path leads to a human, not to
 * money.
 *
 * The token is minted by the GATEWAY, never here. It is signed with the same
 * secret that authenticates every in-app customer; a page that could sign its
 * own could mint one for anybody.
 *
 * THIS PAGE DOES NOT RENDER THE CHAT. It collects a number, gets a token, and
 * hands off to `/` — the one chat surface, the same screen an in-app customer
 * lands on. Two pages that both render a conversation would be two things to
 * keep in step, and only one of them would get tested.
 */

/*
 * SAME ORIGIN BY DEFAULT.
 *
 * This used to default to `http://localhost:8081`. That is right on the
 * machine running the stack and wrong on the only device that matters: a
 * customer standing in a branch scans the code on their PHONE, where
 * `localhost` is the phone. The form failed for every real visitor and worked
 * for everyone testing it.
 *
 * Empty means "my own origin", and the dev server proxies `/walk-in` to the
 * gateway (see vite.config.ts). Behind a tunnel or a real host the request
 * never names a machine the visitor cannot reach. Set
 * VITE_GATEWAY_HTTP_URL only when the gateway genuinely lives somewhere else
 * and is reachable from the public internet.
 */
const GATEWAY_HTTP = (import.meta.env.VITE_GATEWAY_HTTP_URL as string | undefined) ?? '';
const VENDOR_ID = (import.meta.env.VITE_WALK_IN_VENDOR_ID as string | undefined) ?? '1';
/** The chat page this hands off to — same origin, so `/` is the whole answer. */
const CHAT_URL = (import.meta.env.VITE_WALK_IN_CHAT_URL as string | undefined) ?? '/';

/**
 * Where the close button goes.
 *
 * The app opens this page in a web view and registers `closeapp://`, so
 * navigating there hands control back and the customer never learns they left
 * the app. Overridable per host, and when the page is opened in an ordinary
 * browser the scheme simply does not resolve and the widget collapses instead.
 */
const CLOSE_URL = (import.meta.env.VITE_WALK_IN_CLOSE_URL as string | undefined) ?? 'closeapp://';

const form = document.getElementById('walk-in-form') as HTMLFormElement | null;
const input = document.getElementById('phone') as HTMLInputElement | null;
const error = document.getElementById('walk-in-error') as HTMLElement | null;
const submit = document.getElementById('walk-in-submit') as HTMLButtonElement | null;

function showError(message: string): void {
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

/** Put the form back after a link fails, so nobody is stranded. */
function revealForm(): void {
  form?.removeAttribute('hidden');
}

function setBusy(busy: boolean): void {
  if (submit) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Starting…' : 'Start chat';
  }
}

/**
 * Open a session, either from a number the customer typed or from a personal
 * link they were sent.
 *
 * `code` is a short opaque handle, not a phone number. The page never learns
 * whose chat it is opening and could not lie about it if it tried — the gateway
 * looks the number up. A `?phone=` would have been simpler and editable, which
 * on a keyspace of `05` plus eight digits means anybody holding one link could
 * open anybody's chat.
 */
async function start(input: { phone: string } | { code: string }): Promise<void> {
  setBusy(true);
  if (error) error.hidden = true;
  try {
    const res = await fetch(`${GATEWAY_HTTP}/walk-in/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        'code' in input ? { code: input.code } : { phone: input.phone, vendorId: VENDOR_ID },
      ),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string };
    if (res.status === 429) {
      showError('Too many attempts. Please wait a moment and try again.');
      setBusy(false);
      return;
    }
    if (res.status === 401) {
      // An expired or tampered link. Say so plainly and leave the form usable,
      // so the customer is not stranded on a dead link.
      showError('This link has expired. Please enter your number to start a chat.');
      revealForm();
      setBusy(false);
      return;
    }
    if (!res.ok || !body.ok || !body.token) {
      showError('We could not start the chat. Please check the number and try again.');
      revealForm();
      setBusy(false);
      return;
    }
    /*
     * Hand off to the chat page. The token goes through sessionStorage rather
     * than the URL — it authenticates a customer, and a URL carrying one lands
     * in history and referrers. Same origin, so it survives the redirect.
     *
     * `replace`, not `assign`: the customer must not be able to press Back
     * into the phone form once the chat is open. There is nothing to go back
     * to, and in a web view Back is the app's own gesture.
     */
    sessionStorage.setItem('yiji.walkInToken', body.token);
    sessionStorage.setItem('yiji.walkInCloseUrl', CLOSE_URL);
    window.location.replace(CHAT_URL);
  } catch {
    showError('We could not reach support. Please check your connection.');
    setBusy(false);
  }
}

/*
 * The number always starts 05 and the customer types the rest.
 *
 * Prefilled AND held: every Saudi mobile begins 05, so making somebody type it
 * is eight wasted taps at a counter, and letting them delete it produces a
 * number the gateway cannot match. The guard runs on input rather than on
 * submit so the field can never be in a state the form would reject.
 */
const PREFIX = '05';

function holdPrefix(): void {
  if (!input) return;
  let digits = input.value.replace(/\D/g, '');
  // A pasted number is as likely to be +966 5X… as 05X… — the country code is
  // the same number written another way, so convert rather than treating those
  // digits as the start of a local one.
  if (digits.startsWith('966')) digits = `0${digits.slice(3)}`;
  const rest = digits.startsWith(PREFIX) ? digits.slice(PREFIX.length) : digits.replace(/^0+/, '');
  input.value = PREFIX + rest.slice(0, 8);
  // Never let the caret sit inside the prefix — typing there would push digits
  // in front of it, which is how you get a number starting 5005.
  const min = PREFIX.length;
  if ((input.selectionStart ?? 0) < min) input.setSelectionRange(min, min);
}

input?.addEventListener('input', holdPrefix);
input?.addEventListener('focus', () => {
  holdPrefix();
  const end = input.value.length;
  input.setSelectionRange(end, end);
});
if (input && !input.value) input.value = PREFIX;

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const phone = (input?.value ?? '').trim();
  // 05 + 8 digits is the Saudi mobile shape. Checked here so the customer is
  // told at the field rather than by a 400 from the gateway.
  if (phone.replace(/\D/g, '').length < 10) {
    showError('Please enter the full mobile number — 05 and eight more digits.');
    return;
  }
  void start({ phone });
});

/*
 * A PERSONAL LINK SKIPS THE FORM.
 *
 * `?c=<code>` means an operator minted this link for one customer, so asking
 * them to type the number they were already identified by is a step that only
 * loses people. The form is hidden rather than removed: if the token has
 * expired, `start` puts it back and they can carry on by hand.
 *
 * The code is dropped from the address bar immediately. It opens a chat
 * session, and a URL carrying one lands in history, in a screenshot, and in the
 * `Referer` of anything the page later loads.
 */
const linkCode = new URLSearchParams(window.location.search ?? '').get('c');
if (linkCode) {
  form?.setAttribute('hidden', '');
  history.replaceState(null, '', window.location.pathname);
  void start({ code: linkCode });
}
