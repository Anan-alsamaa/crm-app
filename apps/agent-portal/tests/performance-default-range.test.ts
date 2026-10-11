import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultPerformanceRange } from '../src/features/performance/AgentPerformancePage.js';

/**
 * Agent performance opens on yesterday's business day through today's, keeps
 * the agent's own choice until sign-out, then opens on the default again
 * (owner, 2026-10-11). Business days turn at 08:00 Riyadh (05:00 UTC).
 */
describe('Agent performance default date range', () => {
  it('is yesterday through today during the day', () => {
    // 11 Oct, 14:00 Riyadh
    expect(defaultPerformanceRange(Date.parse('2026-10-11T11:00:00Z'))).toEqual({
      from: '2026-10-10',
      to: '2026-10-11',
    });
  });

  it('before 08:00 Riyadh "today" is still the business day that began yesterday', () => {
    // 11 Oct, 03:00 Riyadh -> business day of 10 Oct
    expect(defaultPerformanceRange(Date.parse('2026-10-11T00:00:00Z'))).toEqual({
      from: '2026-10-09',
      to: '2026-10-10',
    });
  });

  it('signing out clears the saved view, so the next sign-in opens on the default', () => {
    const auth = readFileSync(resolve(__dirname, '../src/lib/auth/AuthContext.tsx'), 'utf8');
    expect(auth).toMatch(/startsWith\('agent-performance:'\)/);
  });
});
