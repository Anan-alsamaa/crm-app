import { describe, it, expect } from 'vitest';
import { canSeeFieldHistory } from '../src/features/tickets/history-visibility.js';

/*
 * WHO MAY READ THE EDIT HISTORY (owner, 2026-09-16).
 *
 * "What changed" is the audit trail: every field edit with the person who made
 * it. That is a supervisory view — it exists for checking work — so putting it
 * in front of the agent whose work it records changes what the panel is for.
 *
 * Pinned as a rule rather than through a rendered page because the rule is the
 * part that can be wrong, and a role list is exactly the kind of thing that
 * gets extended later without anybody re-reading who it now admits.
 */
describe('canSeeFieldHistory', () => {
  it('admits the three supervisory roles the owner named', () => {
    for (const role of ['Administrator', 'WeCare Admin', 'WeCare Supervisor']) {
      expect(canSeeFieldHistory(role), role).toBe(true);
    }
  });

  it('keeps it from a WeCare Agent — it is their work being audited', () => {
    expect(canSeeFieldHistory('WeCare Agent')).toBe(false);
    expect(canSeeFieldHistory('Agent')).toBe(false);
  });

  it('ignores case, because role names are typed by people', () => {
    expect(canSeeFieldHistory('wecare supervisor')).toBe(true);
    expect(canSeeFieldHistory('WECARE ADMIN')).toBe(true);
  });

  it('FAILS CLOSED on anything it does not recognise', () => {
    // A renamed or newly invented role must hide the panel, never reveal it.
    // Hidden-when-it-should-show is a complaint; shown-when-it-should-not is
    // an agent reading an audit trail of themselves.
    for (const role of [null, undefined, '', 'Viewer', 'Operations', 'svc-workers']) {
      expect(canSeeFieldHistory(role), String(role)).toBe(false);
    }
  });
});
