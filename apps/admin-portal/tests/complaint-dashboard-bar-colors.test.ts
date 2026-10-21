import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "By chain manager" drew no bars (owner, 2026-10-12): its colour was
 * `bg-violet-500`, but the UI preset replaces Tailwind's `violet` family with
 * a single theme token, so that class produced no CSS. Every chart colour on
 * the dashboard must be one that actually renders.
 *
 * Since the bento cards (owner, 2026-10-15) a breakdown card takes a TONE, and
 * each tone in `components/dash/Dash.tsx` spells its colours out as literal
 * classes, so Tailwind always generates them. The rule is now: every tone the
 * dashboard names exists in that table, and no numbered shade sneaks back.
 */
const SRC = readFileSync(
  resolve(__dirname, '../src/features/dashboard/ComplaintDashboard.tsx'),
  'utf8',
);
const DASH = readFileSync(resolve(__dirname, '../src/components/dash/Dash.tsx'), 'utf8');
const TONES = [
  ...(DASH.match(/export type Tone = ([^;]+);/)?.[1] ?? '').matchAll(/'([a-z]+)'/g),
].map((m) => m[1]);

const THEME = [
  'primary',
  'magenta',
  'sky',
  'violet',
  'success',
  'destructive',
  'foreground',
  'hero',
  'muted',
  'warning',
];

describe('complaint dashboard bar colours', () => {
  it('every card tone is one the tone table defines', () => {
    expect(TONES.length).toBeGreaterThan(0);
    const used = [...SRC.matchAll(/tone="([a-z]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    // Rings and gauges take the theme's own tokens; cards take a tone.
    const allowed = [...TONES, ...THEME];
    for (const t of used) expect(allowed).toContain(t);
    // ...and every tone in the table has its colour classes written out.
    for (const t of TONES) expect(DASH).toMatch(new RegExp(`\\n  ${t}: \\{\\n    wash: 'bg-`));
  });

  it('never a numbered Tailwind shade', () => {
    expect(SRC).not.toMatch(/(color|className)="[^"]*\bbg-[a-z]+-\d{2,3}\b/);
  });
});
