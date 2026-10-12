import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "By chain manager" drew no bars (owner, 2026-10-12): its colour was
 * `bg-violet-500`, but the UI preset replaces Tailwind's `violet` family with
 * a single theme token, so that class produced no CSS. Every chart colour on
 * the dashboard must be a theme token.
 */
const SRC = readFileSync(
  resolve(__dirname, '../src/features/dashboard/ComplaintDashboard.tsx'),
  'utf8',
);
const TOKENS = ['primary', 'magenta', 'sky', 'violet', 'success', 'destructive', 'foreground'];

describe('complaint dashboard bar colours', () => {
  it('uses only theme tokens', () => {
    const used = [...SRC.matchAll(/color="bg-([a-z-]+?)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(TOKENS).toContain(c);
  });

  it('never a numbered Tailwind shade', () => {
    expect(SRC).not.toMatch(/color="bg-[a-z]+-\d{2,3}"/);
  });
});
