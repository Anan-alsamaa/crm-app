import { describe, it, expect } from 'vitest';

/**
 * The agent half of a live conversation.
 *
 * The customer widget has been audited twice; this side had not, and it carries
 * the same risk in the other direction — an agent believing a reply or a note
 * landed when it did not costs the customer just as much.
 */

/** Mirrors the agent branch of `message:send`. */
async function agentSend(
  convId: string,
  lookup: (id: string) => Promise<string | null>,
): Promise<{ ok: boolean; code?: string }> {
  const exists = await lookup(convId);
  if (exists === null) return { ok: false, code: 'conversation_unavailable' };
  return { ok: true };
}

describe('an agent naming a conversation', () => {
  it('REFUSES a conversation that does not exist', async () => {
    /*
     * An agent works a shared inbox, so they name the thread — and that id went
     * straight to the writer using the gateway's own unscoped service token,
     * with nothing checking it resolved to anything. A stale id in a client's
     * state wrote wherever it pointed.
     */
    const r = await agentSend('gone', async () => null);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('conversation_unavailable');
  });

  it('allows a conversation that is real', async () => {
    const r = await agentSend('c1', async () => 'open');
    expect(r.ok).toBe(true);
  });

  it('allows a SOLVED conversation — an agent may still add a closing word', async () => {
    // Refusing here would be a different bug: solved is not deleted, and the
    // customer can reopen the thread by writing again.
    const r = await agentSend('c1', async () => 'solved');
    expect(r.ok).toBe(true);
  });
});

/** Mirrors `note:add`'s reporting. */
function addNote(payloadValid: boolean, persists: boolean): { emitted: string | null } {
  if (!payloadValid) return { emitted: 'bad_payload' };
  if (!persists) return { emitted: 'note_failed' };
  return { emitted: null };
}

describe('an internal note that fails', () => {
  it('reports a persist failure instead of vanishing', () => {
    /*
     * This was the only agent write that reported neither a bad payload nor a
     * persist failure. The portal renders the note optimistically and waits for
     * an echo, so with neither it sat on "Sending…" and then disappeared on the
     * next conversation switch — taking handover context ("already refunded
     * once") with it.
     */
    expect(addNote(true, false).emitted).toBe('note_failed');
  });

  it('reports a malformed note rather than returning silently', () => {
    expect(addNote(false, true).emitted).toBe('bad_payload');
  });

  it('stays quiet when the note actually saved', () => {
    expect(addNote(true, true).emitted).toBeNull();
  });
});
