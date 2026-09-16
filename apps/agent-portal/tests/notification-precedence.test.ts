import { describe, it, expect } from 'vitest';
import { resolvePreferences } from '../src/features/notifications/api.js';

/*
 * BOTH CAN SET; THE ADMINISTRATOR WINS (owner, 2026-09-16).
 *
 * An agent controls their own notifications, and an administrator can set an
 * organisation policy. Where the two disagree, the organisation's answer is the
 * one that applies.
 *
 * The part worth pinning is what happens to the agent's choice underneath. It
 * is NOT overwritten: it stays stored, and it governs again the moment the
 * administrator stops dictating that type. The alternative — writing the policy
 * onto every user's row — would be irreversible and would silently discard a
 * choice somebody made on purpose, which is the kind of thing nobody reports
 * because it looks like they mis-remembered.
 */
describe('resolvePreferences', () => {
  it('uses the agent’s own choice when there is no policy', () => {
    const out = resolvePreferences({ sla_breach: 'email' }, {});
    expect(out.sla_breach).toBe('email');
  });

  it('lets the administrator override the agent, type by type', () => {
    const out = resolvePreferences({ sla_breach: 'none' }, { sla_breach: 'both' });
    // The agent muted it; the organisation says everybody gets it.
    expect(out.sla_breach).toBe('both');
  });

  it('leaves every OTHER type to the agent', () => {
    // A policy on one notification is not a policy on all of them — dictating
    // SLA breaches must not quietly seize the rest.
    const out = resolvePreferences(
      { sla_breach: 'none', assignment: 'email' },
      { sla_breach: 'both' },
    );
    expect(out.sla_breach).toBe('both');
    expect(out.assignment).toBe('email');
  });

  it('does not destroy the agent’s choice — lifting the policy restores it', () => {
    const mine = { sla_breach: 'none' };
    expect(resolvePreferences(mine, { sla_breach: 'both' }).sla_breach).toBe('both');
    // Same stored `mine`, policy withdrawn: their own answer governs again.
    expect(resolvePreferences(mine, {}).sla_breach).toBe('none');
  });

  it('falls back to "both" when neither has said anything', () => {
    const out = resolvePreferences({}, {});
    expect(out.assignment).toBe('both');
  });

  it('survives null and undefined from either side', () => {
    // A user with no preferences row and no policy is the ordinary state of a
    // fresh deployment; it must not throw on the page everyone opens.
    expect(resolvePreferences(null, null).assignment).toBe('both');
    expect(resolvePreferences(undefined, undefined).assignment).toBe('both');
  });

  it('answers for every notification type, not only the ones mentioned', () => {
    const out = resolvePreferences({}, {});
    // The page renders a row per type; a missing key would render an empty
    // control rather than a default.
    expect(Object.values(out).every((v) => typeof v === 'string')).toBe(true);
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });
});
