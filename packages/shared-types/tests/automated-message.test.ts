import { describe, it, expect } from 'vitest';
import {
  isAutomatedAgentMessage,
  isHumanAgentMessage,
  HUMAN_AGENT_MESSAGE_FILTER,
  pickWelcomeTemplate,
  renderWelcomeTemplate,
  messageEditRefusal,
} from '../src/index.js';

/**
 * ONE RULE FOR "NOBODY SENT THIS" (owner, 2026-10-06): the automatic welcome is
 * an agent-style message with a null `sender_user`. Every consumer that reads
 * an agent message as "answered" asks this helper, so they cannot drift.
 */
describe('isAutomatedAgentMessage', () => {
  it('is true for an agent message with an explicit null sender_user', () => {
    expect(isAutomatedAgentMessage({ sender_type: 'agent', sender_user: null })).toBe(true);
    expect(isAutomatedAgentMessage({ sender_type: 'agent', sender_user: { id: null } })).toBe(true);
  });

  it('is false for a person, a customer or the system', () => {
    expect(isAutomatedAgentMessage({ sender_type: 'agent', sender_user: 'u1' })).toBe(false);
    expect(isAutomatedAgentMessage({ sender_type: 'agent', sender_user: { id: 'u1' } })).toBe(
      false,
    );
    expect(isAutomatedAgentMessage({ sender_type: 'customer', sender_user: null })).toBe(false);
    // The idle-close farewell is `system`, not this.
    expect(isAutomatedAgentMessage({ sender_type: 'system', sender_user: null })).toBe(false);
  });

  /* THE TRAP: a field nobody SELECTED is undefined. Reading that as "no
     human" would turn every reply into the welcome and every chat into
     "unanswered" the first time a query forgot the field. */
  it('treats an UNSELECTED sender_user as unknown, i.e. a human reply', () => {
    expect(isAutomatedAgentMessage({ sender_type: 'agent' })).toBe(false);
    expect(isHumanAgentMessage({ sender_type: 'agent' })).toBe(true);
  });

  it('isHumanAgentMessage is the complement for agent messages only', () => {
    expect(isHumanAgentMessage({ sender_type: 'agent', sender_user: 'u1' })).toBe(true);
    expect(isHumanAgentMessage({ sender_type: 'agent', sender_user: null })).toBe(false);
    expect(isHumanAgentMessage({ sender_type: 'customer', sender_user: null })).toBe(false);
    expect(isHumanAgentMessage(null)).toBe(false);
  });

  it('has a Directus filter twin for server-side counts', () => {
    expect(HUMAN_AGENT_MESSAGE_FILTER).toEqual({
      sender_type: { _eq: 'agent' },
      sender_user: { _nnull: true },
    });
  });

  /* Nobody owns it, so nobody may rewrite or withdraw it. */
  it('is never editable', () => {
    expect(
      messageEditRefusal(
        { sender_type: 'agent', sender_user: null, date_created: new Date().toISOString() },
        'agent-1',
        Date.now(),
      ),
    ).toBe('not_own_message');
  });
});

describe('pickWelcomeTemplate', () => {
  it("prefers the customer's language, else whichever exists", () => {
    const both = { ar: 'أهلًا', en: 'Hello' };
    expect(pickWelcomeTemplate(both, 'ar')).toBe('أهلًا');
    expect(pickWelcomeTemplate(both, 'en')).toBe('Hello');
    // Production: ONE bilingual `ar` row. An English writer still gets it.
    expect(pickWelcomeTemplate({ ar: 'أهلًا / Welcome', en: null }, 'en')).toBe('أهلًا / Welcome');
    expect(pickWelcomeTemplate({ ar: null, en: 'Hello' }, 'ar')).toBe('Hello');
  });

  /* No row, inactive row, failed read: all arrive as nulls — send nothing. */
  it('returns null when there is nothing to send', () => {
    expect(pickWelcomeTemplate({ ar: null, en: null }, 'ar')).toBeNull();
    expect(pickWelcomeTemplate({ ar: '  ', en: '' }, 'en')).toBeNull();
    expect(pickWelcomeTemplate(null, 'ar')).toBeNull();
  });
});

describe('renderWelcomeTemplate', () => {
  it('substitutes the name', () => {
    expect(renderWelcomeTemplate('Welcome {name}, how can we help?', 'Ayman')).toBe(
      'Welcome Ayman, how can we help?',
    );
  });

  it('removes the placeholder cleanly when there is no name', () => {
    expect(renderWelcomeTemplate('Welcome {name}, how can we help?', null)).toBe(
      'Welcome, how can we help?',
    );
    expect(renderWelcomeTemplate('Welcome {name}! How can we help?', '  ')).toBe(
      'Welcome! How can we help?',
    );
    expect(renderWelcomeTemplate('مرحبًا {name}، كيف نساعدك؟', null)).toBe('مرحبًا، كيف نساعدك؟');
    expect(renderWelcomeTemplate('{name}', null)).toBe('');
  });

  /* The production template is two paragraphs; flattening would garble both. */
  it('keeps line breaks', () => {
    const tpl = 'أهلًا وسهلًا بك 🌹\nسعداء بتواصلك\n\nWelcome 👋\nWe are happy to help.';
    expect(renderWelcomeTemplate(tpl, null)).toBe(tpl);
  });
});
