import type { HTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';

type Size = 'xs' | 'sm' | 'md' | 'lg';

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Name to derive initials and a deterministic color from. */
  name?: string | null;
  /** Email to fall back on when name is empty. */
  email?: string | null;
  size?: Size;
  /** Optional image URL; if it fails to load, falls through to initials. */
  src?: string | null;
}

const sizes: Record<Size, string> = {
  xs: 'h-6 w-6 text-2xs',
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-md',
};

/*
 * Pick a stable hue from the identity string so two agents see the same
 * customer in the same color, but different customers don't collide visually.
 * 12 hue stops in OKLCH around the neutral lightness 0.78 so contrast on
 * white initials stays consistent.
 */
const HUES = [25, 50, 80, 130, 165, 200, 230, 260, 290, 320, 350, 12];

function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
}

function initialsOf(name?: string | null, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0] || '';
  if (!source) return '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (first && second) {
    return ((first[0] ?? '') + (second[0] ?? '')).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  email,
  size = 'sm',
  src,
  className,
  ...rest
}: AvatarProps): JSX.Element {
  const seed = (name || email || 'anon').toLowerCase();
  const hue = hueFor(seed);
  const bg = `oklch(0.78 0.10 ${hue})`;
  const initials = initialsOf(name, email);

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
        'shadow-sm shadow-foreground/10 ring-1 ring-inset ring-white/20',
        sizes[size],
        className,
      )}
      style={{ background: bg }}
      aria-hidden
      {...rest}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full rounded-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        initials
      )}
    </span>
  );
}
