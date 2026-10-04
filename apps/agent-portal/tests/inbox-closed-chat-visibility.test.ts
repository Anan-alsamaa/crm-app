import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFilter } from '../src/features/inbox/api.js';

/**
 * A CLOSED CHAT IS VISIBLE TO EVERY AGENT. AN OPEN ONE IS NOT.
 *
 * Asked for by operations (2026-10-04): *"Once any chat is closed, the chat
 * should be visible to all agents. Right now we have an assignment mechanism.
 * Once a chat is closed, it should become open to all agents."*
 *
 * This is a narrowing of a change the owner REFUSED on 2026-09-14, and the
 * distinction is the whole justification — so it is pinned here rather than
 * left to a comment. That refusal protected a LIVE thread somebody owns: an
 * agent must not read a colleague's open chat. A SOLVED chat is finished work
 * — nobody is working it, no ownership is left to respect, and it is exactly
 * the history the 2026-08-16 complaint was about (a returning customer made to
 * repeat a story the company already had).
 *
 * TWO LAYERS, and the client one is cosmetic on its own: the Directus
 * row-level permission is the real boundary. Both are asserted, because
 * changing one without the other is how this feature silently returns nothing.
 */

const MINE = 'agent-1';
const TEAM = 'team-9';

/** The `_or` clause the assignment scope produces. */
const scopeOf = (f: Parameters<typeof buildFilter>[0]) => {
  const built = buildFilter(f) as { _and?: Array<Record<string, unknown>> } | undefined;
  const ors = (built?._and ?? []).filter((c) => '_or' in c) as Array<{
    _or: Array<Record<string, unknown>>;
  }>;
  /* The assignment scope is the one carrying `assigned_agent` — a search adds
     its own `_or`, and picking by position would silently test the wrong one. */
  return ors.find((c) => c._or.some((x) => 'assigned_agent' in x))?._or ?? [];
};

describe('which chats an ordinary agent sees', () => {
  const base = { assignment: 'mine' as const, currentUserId: MINE, currentTeamId: TEAM };

  it('still shows their own, the pool, and their team', () => {
    const or = scopeOf(base);
    expect(or).toEqual(
      expect.arrayContaining([
        { assigned_agent: { _eq: MINE } },
        { assigned_agent: { _null: true } },
        { assigned_team: { _eq: TEAM } },
      ]),
    );
  });

  /* THE NEW CLAUSE. */
  it('also shows every closed chat', () => {
    expect(scopeOf(base)).toEqual(
      expect.arrayContaining([{ status: { _in: ['solved', 'resolved', 'closed'] } }]),
    );
  });

  /*
   * ALL THREE SPELLINGS, not just `solved`.
   *
   * `normaliseConversationStatus` collapses the vocabulary to `open | solved`,
   * but the column has historically held `resolved` and `closed` too — the
   * gateway's own `RESUMABLE_STATUSES` names all three. A filter matching only
   * `solved` would leave older rows invisible for no visible reason: the silent
   * empty-result shape this codebase keeps producing.
   */
  it('matches the retired status spellings too', () => {
    const clause = scopeOf(base).find((c) => 'status' in c) as
      | { status: { _in: string[] } }
      | undefined;
    expect(clause?.status._in).toEqual(['solved', 'resolved', 'closed']);
  });

  /*
   * AND IT DOES NOT WIDEN "ALL CONVERSATIONS".
   *
   * An agent holding `view_all_chats` browses with `assignment: 'all'`, which
   * adds no assignment scope at all. The closed clause must ride INSIDE the
   * mine-scope and not become a second, standalone filter — otherwise it would
   * narrow a wide view to closed chats only.
   */
  it('adds nothing when the agent is browsing all conversations', () => {
    const built = buildFilter({ assignment: 'all', currentUserId: MINE }) as {
      _and?: Array<Record<string, unknown>>;
    };
    const ors = (built?._and ?? []).filter((c) => '_or' in c);
    expect(ors).toHaveLength(0);
  });

  /* A search still gets its own clause, and the two must not be confused. */
  it('keeps the search clause separate from the assignment scope', () => {
    const or = scopeOf({ ...base, search: 'ahmed' });
    expect(or.some((c) => 'assigned_agent' in c)).toBe(true);
    expect(or.some((c) => 'contact' in c)).toBe(false);
  });
});

/**
 * THE REAL BOUNDARY — the Directus row-level permission.
 *
 * The client filter only asks for fewer rows; the permission decides what the
 * API will hand over. Asserted against the source of BOTH the bootstrap and
 * the runtime extension, because they must agree —
 * `scripts/check-permission-drift.mjs` fails when they do not, and a change
 * applied to one alone produces an inbox that lists nothing it promised.
 */
const ROLES = readFileSync(
  resolve(import.meta.dirname, '../../../directus/bootstrap/src/roles.ts'),
  'utf8',
);
const SYNC = readFileSync(
  resolve(import.meta.dirname, '../../../directus/extensions/app-roles-sync/index.js'),
  'utf8',
);

describe('the row-level permission', () => {
  it('reads closed chats in both the bootstrap and the extension', () => {
    expect(ROLES).toMatch(/const ASSIGNED_UNASSIGNED_OR_SOLVED = \{/);
    expect(SYNC).toMatch(/const ASSIGNED_UNASSIGNED_OR_SOLVED = \{/);
    expect(ROLES).toMatch(/action: 'read',\s*permissions: ASSIGNED_UNASSIGNED_OR_SOLVED/);
    expect(SYNC).toMatch(/g\('conversations', 'read', ASSIGNED_UNASSIGNED_OR_SOLVED\)/);
  });

  /*
   * AND UPDATE IS SCOPED AGAIN — the half that makes this safe.
   *
   * `conversations.update` was UNSCOPED, and the comment above it said why that
   * was acceptable: "the scoped READ is what keeps this narrow… any chat they
   * could already open". Opening closed chats to everyone destroys that
   * premise. Left alone, this request would have silently granted every agent
   * write access to every closed conversation in the system — reassigning and
   * re-opening included.
   *
   * The wide update for people who must act on other people's work still rides
   * with `edit_all_tickets`, and Directus ORs the two, so supervisors keep
   * being able to close a chat they do not own.
   */
  it('keeps update on the LIVE scope, not the widened one', () => {
    expect(ROLES).toMatch(/action: 'update',\s*permissions: ASSIGNED_OR_UNASSIGNED/);
    expect(SYNC).toMatch(/g\('conversations', 'update', ASSIGNED_OR_UNASSIGNED\)/);
    /* THE REGRESSION: an unscoped update beside a widened read. */
    expect(SYNC).not.toMatch(/g\('conversations', 'update'\),/);
  });

  it('leaves the supervisors their wide update', () => {
    expect(SYNC).toMatch(/g\('conversations', 'update', \{\}\)/);
  });

  /* Messages follow their conversation, or a listed chat opens empty. */
  it('lets the messages of a closed chat be read', () => {
    expect(ROLES).toMatch(
      /CONVERSATION_ASSIGNED_OR_UNASSIGNED = \{ conversation: ASSIGNED_UNASSIGNED_OR_SOLVED \}/,
    );
    expect(SYNC).toMatch(
      /MESSAGE_OF_VISIBLE_CONVERSATION = \{ conversation: ASSIGNED_UNASSIGNED_OR_SOLVED \}/,
    );
  });
});
