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
 * THE TWO SURFACES MUST DISAGREE, ON PURPOSE.
 *
 * The first version of this file asserted that the widget rendered every
 * system message as `system`, and called that "already correct". The owner
 * then looked at the result (2026-10-02): the farewell reached the CUSTOMER as
 * a machine notice, when to them it is simply the support team saying goodbye.
 * The business's own closing words read as automated.
 *
 * So the rule is not "system renders as system" — it is that the SOURCE
 * decides:
 *
 *   the AGENT sees "System", because they need to know the idle sweep wrote
 *   it and not a colleague;
 *
 *   the CUSTOMER sees a normal incoming message, because from their side the
 *   business is speaking to them.
 *
 * The widget's own local notices ("not sent", "nobody is online", "that file
 * was too big") stay machinery on both sides, and are told apart by
 * `localNotice` — never by their text, which is translated and editable.
 */
const WIDGET = read('../chat-widget/src/Widget.tsx');
const WIDGET_SOCKET = read('../chat-widget/src/socket.ts');

describe('the customer widget', () => {
  it('shows an arriving system message as the business speaking', () => {
    expect(WIDGET).toMatch(/m\.senderType === 'system' && m\.localNotice\s*\?\s*'system'/);
  });

  /* The regression this replaced: an unconditional `system` branch put the
     farewell in a grey machine bubble. */
  it('no longer renders every system message as machinery', () => {
    expect(WIDGET).not.toMatch(/senderType === 'system'\s*\n?\s*\?\s*'system'/);
  });

  /*
   * EVERY LOCALLY-CREATED SYSTEM BUBBLE MUST BE MARKED. An unmarked one is
   * indistinguishable from a message the server sent, so it would be shown to
   * the customer as though an agent had written it — "could not upload that
   * file" in support's own voice.
   */
  it.each(['agents-offline', 'send-failed', 'attach-failed'])(
    'marks its own %s notice as local',
    (marker) => {
      expect(WIDGET).toContain(`localNotice: '${marker}'`);
      expect(WIDGET_SOCKET).toContain(`'${marker}'`);
    },
  );
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
