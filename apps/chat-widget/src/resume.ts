/**
 * Which conversation THIS DEVICE opened.
 *
 * An unverified walk-in (a phone number typed on the store QR page) is given a
 * thread of its own and, on purpose, cannot resume anything by phone: a typed
 * number is not proof, and the thread it names may be somebody else's. That
 * left one honest case broken. The same person reloads the page, or scans
 * the code again on the way out, and their next message opens a SECOND thread
 * beside the first: same number, twice in the inbox, minutes apart.
 *
 * The device remembers the id it was handed and offers it back on the next
 * connection. Nobody else was ever given that id, so holding it is the proof
 * the phone number is not. The gateway still decides: it resumes only once the
 * database confirms the id is this very contact's live thread, and ignores
 * the offer entirely for an in-app customer, whose thread is resolved by
 * contact as before.
 *
 * Keyed by the customer the token names, so a different number typed on the
 * same device is a different key and never inherits a thread. The claims are
 * DECODED, not verified. The widget has no signing secret and needs none: this
 * is a cache key, and ownership is settled server-side.
 */

const PREFIX = 'yiji.conversation.';

function decodeClaims(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    // Byte-wise, then UTF-8: a name in the payload may well be Arabic.
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The storage key for the customer a token names, or null if it names none. */
export function conversationStorageKey(token: string): string | null {
  const claims = decodeClaims(token);
  const vendor = claims?.vendor_id;
  const customer = claims?.customer_id;
  if (typeof vendor !== 'string' || typeof customer !== 'string' || !vendor || !customer) {
    return null;
  }
  return `${PREFIX}${vendor}.${customer}`;
}

/** The conversation this device holds for the token's customer, if any. */
export function recallConversation(token: string): string | null {
  const key = conversationStorageKey(token);
  if (!key) return null;
  try {
    return localStorage.getItem(key) || null;
  } catch {
    // Private mode, storage disabled: no memory, which only costs a resume.
    return null;
  }
}

export function rememberConversation(token: string, conversationId: string): void {
  const key = conversationStorageKey(token);
  if (!key) return;
  try {
    localStorage.setItem(key, conversationId);
  } catch {
    /* see recallConversation */
  }
}

export function forgetConversation(token: string): void {
  const key = conversationStorageKey(token);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* see recallConversation */
  }
}
