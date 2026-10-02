import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A CHAT HAS THREE VOICES, NOT TWO.
 *
 * The bug (owner, 2026-10-02): the idle-close farewell — the message WE send to
 * end a quiet chat — appeared in the agent's thread as though the CUSTOMER had
 * written it. Their name above it, their avatar beside it, their side of the
 * thread.
 *
 * THE DATA WAS NEVER WRONG. All ten of these messages on live production carry
 * `sender_type: 'system'` with a null `sender_user` and a null `sender_contact`.
 * The sweep writes exactly what it intends to write.
 *
 * The fault was one line of rendering: `isAgent = sender_type === 'agent'`, and
 * then everything that was not the agent was treated as the customer —
 * `senderLabel`, the avatar (carrying the customer's real phone and email), the
 * row direction and the bubble colour. A system message inherited a stranger's
 * whole identity by default.
 *
 * The customer's own widget already got this right: it renders `customer` /
 * `system` / `theirs` as three distinct kinds. The two surfaces now agree.
 *
 * Asserted against the SOURCE: the rendering needs a conversation, a socket, a
 * QueryClient and an auth context to reach, and mocking all four to inspect one
 * CSS branch would be testing the mocks. What matters is that the component
 * keeps asking the three-way question.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const VIEW = read('src/features/conversation/ConversationView.tsx');

describe('a system message in the agent thread', () => {
  it('is recognised as its own kind', () => {
    expect(VIEW).toContain("const isSystem = head.sender_type === 'system'");
  });

  /*
   * THE REGRESSION ITSELF. `senderLabel` fell through to `contactName`, which is
   * what put the customer's name above our own farewell.
   */
  it('is not labelled with the customer name', () => {
    expect(VIEW).toMatch(/const senderLabel = isSystem/);
    expect(VIEW).toContain("t('conversation.system'");
  });

  /*
   * THE AVATAR CARRIED THE CUSTOMER'S PHONE AND EMAIL. On a message they did
   * not send, that is not just confusing — it attributes our words to a real,
   * identifiable person.
   */
  it('renders no avatar at all', () => {
    expect(VIEW).toMatch(/\{!isSystem && \(\s*<Avatar/);
  });

  /* Centred, like the widget's own system bubble: it belongs to neither side
     of the thread, so it must not sit on either. */
  it('is centred rather than taking a side', () => {
    expect(VIEW).toMatch(/isSystem\s*\?\s*'flex-col items-center'/);
  });

  /* And it must not borrow either side's colour. */
  it('uses a neutral bubble, not the customer bubble', () => {
    expect(VIEW).toMatch(/isSystem\s*\?[\s\S]{0,400}bg-secondary\/60/);
  });

  /* A tail points at a sender; a system message has none. */
  it('has no bubble tail', () => {
    expect(VIEW).toContain('isLast && isAgent && !isSystem');
    expect(VIEW).toContain('isLast && !isAgent && !isSystem');
  });
});

/**
 * The widget was already correct, and must stay so — it is the surface the
 * CUSTOMER reads, where mislabelling our farewell as their own message would be
 * the more confusing of the two failures.
 */
const WIDGET = read('../chat-widget/src/Widget.tsx');

describe('the customer widget', () => {
  it('still renders system messages as their own kind', () => {
    expect(WIDGET).toMatch(/senderType === 'system'\s*\?\s*'system'/);
  });
});

/**
 * And the sweep must keep WRITING `system`. If this ever became `agent` the
 * farewell would be counted as an agent reply — inflating response-time
 * measures and, worse, making a closed chat look answered.
 */
const SWEEP = read('../../services/socket-gateway/src/idle-close.ts');

describe('the idle-close sweep', () => {
  it('writes the goodbye as a system message', () => {
    expect(SWEEP).toContain("senderType: 'system'");
  });
});
