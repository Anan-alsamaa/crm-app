import { describe, expect, it } from 'vitest';
import { isTvScreenRole } from '../src/features/late-orders/LateOrdersPage.js';

/* Owner, 2026-10-22: the TV Screen role opens late orders on the board;
   everyone else on the table. */
describe('isTvScreenRole', () => {
  it('matches the TV Screen role whatever the case or spacing', () => {
    for (const r of ['TV Screen', 'tv screen', ' TV  Screen '])
      expect(isTvScreenRole(r)).toBe(true);
  });

  it('is false for every other role, and for none', () => {
    for (const r of ['WeCare Agent', 'Administrator', 'Operations', 'TV', '', null, undefined]) {
      expect(isTvScreenRole(r)).toBe(false);
    }
  });
});
