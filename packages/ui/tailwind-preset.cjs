/**
 * Shared TailwindCSS preset for all Yiji CRM frontends.
 *
 * Design system synthesized from the three reference skills:
 *
 *  - taste-skill points dashboards/admin UIs at shadcn/ui's owned-component
 *    foundation. We adopt its token NAMES (background/foreground/card/popover/
 *    primary/secondary/muted/accent/destructive/border/input/ring/radius) so
 *    primitives map 1:1 to community patterns.
 *
 *  - impeccable's Neo Kinpaku visual language (dark lacquer surfaces, kinpaku
 *    gold + verdigris patina accents, hairlines, small radii, restrained
 *    shadow) defines the actual palette in OKLCH. Dark is the default —
 *    operators live in this tool 8h/day.
 *
 *  - emil-design-eng's motion curves and durations are exposed as Tailwind
 *    timing-function and duration tokens.
 *
 * Per-tenant branding overrides --brand-primary at runtime; --primary falls
 * back to it so the shadcn primary slot stays vendor-themable.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1320px' },
    },
    extend: {
      colors: {
        // shadcn-style semantic slots, driven by CSS variables set in
        // each portal's index.css (light + dark).
        background: 'oklch(var(--background) / <alpha-value>)',
        canvas: 'oklch(var(--canvas) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
          subtle: 'oklch(var(--primary-subtle) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'oklch(var(--success) / <alpha-value>)',
          foreground: 'oklch(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'oklch(var(--warning) / <alpha-value>)',
          foreground: 'oklch(var(--warning-foreground) / <alpha-value>)',
        },
        border: 'oklch(var(--border) / <alpha-value>)',
        'border-strong': 'oklch(var(--border-strong) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        rail: {
          DEFAULT: 'oklch(var(--rail) / <alpha-value>)',
          foreground: 'oklch(var(--rail-foreground) / <alpha-value>)',
          active: 'oklch(var(--rail-active) / <alpha-value>)',
          'active-foreground': 'oklch(var(--rail-active-foreground) / <alpha-value>)',
          border: 'oklch(var(--rail-border) / <alpha-value>)',
        },
        'secondary-brand': {
          DEFAULT: 'oklch(var(--secondary-brand) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-brand-foreground) / <alpha-value>)',
        },
        display: 'oklch(var(--display) / <alpha-value>)',
        // Aurora gradient companions to the primary.
        violet: 'oklch(var(--violet) / <alpha-value>)',
        magenta: 'oklch(var(--magenta) / <alpha-value>)',
        // Incoming chat bubble surface (messenger-vibrant direction).
        bubble: 'oklch(var(--bubble) / <alpha-value>)',
        // Per-vendor branding hook (legacy + runtime override).
        brand: {
          primary: 'var(--brand-primary, oklch(0.84 0.19 80.46))',
          secondary: 'var(--brand-secondary, oklch(0.70 0.12 188))',
          accent: 'var(--brand-accent, oklch(0.84 0.19 80.46))',
        },
      },
      fontFamily: {
        // System sans (impeccable product register allows system stacks).
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
        arabic: ['"Noto Sans Arabic"', 'Tahoma', 'sans-serif'],
      },
      fontSize: {
        // Fixed rem scale (impeccable product register: not fluid clamp).
        // 1.125-1.2 ratio between steps.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.625rem' }],
        xl: ['1.1875rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.375rem', { lineHeight: '1.875rem', letterSpacing: '-0.01em' }],
        '3xl': ['1.625rem', { lineHeight: '2.125rem', letterSpacing: '-0.015em' }],
        '4xl': ['1.9375rem', { lineHeight: '2.375rem', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        // Small radii per impeccable.
        none: '0',
        xs: '2px',
        sm: 'calc(var(--radius) - 4px)',
        DEFAULT: 'calc(var(--radius) - 2px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 2px)',
        '2xl': 'calc(var(--radius) + 6px)',
        full: '9999px',
      },
      boxShadow: {
        // Restrained shadow; never decorative.
        none: 'none',
        xs: '0 1px 0 0 oklch(var(--shadow-color) / 0.04)',
        sm: '0 1px 2px 0 oklch(var(--shadow-color) / 0.06)',
        DEFAULT: '0 1px 3px 0 oklch(var(--shadow-color) / 0.08), 0 1px 2px -1px oklch(var(--shadow-color) / 0.06)',
        md: '0 4px 12px -2px oklch(var(--shadow-color) / 0.12)',
        lg: '0 10px 30px -10px oklch(var(--shadow-color) / 0.24)',
        ring: '0 0 0 2px oklch(var(--ring) / 0.55)',
      },
      transitionTimingFunction: {
        // emil-design-eng custom curves.
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      transitionDuration: {
        // Product-register transition durations: 150-250ms typical.
        fast: '120ms',
        DEFAULT: '160ms',
        base: '160ms',
        medium: '200ms',
        slow: '240ms',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-up-and-fade': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down-and-fade': {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        // Slow gradient drift for premium brand surfaces (login, hero, etc).
        'mesh-drift': {
          '0%, 100%': { backgroundPosition: '0% 0%, 100% 100%' },
          '50%': { backgroundPosition: '30% 20%, 70% 80%' },
        },
        // Subtle scale pulse for brand marks.
        'soft-pulse': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.04)', opacity: '0.92' },
        },
        // Right-side drawer entrance (start side in RTL — done in CSS via inset-y/end).
        'slide-in-drawer': {
          '0%': { transform: 'translateX(8%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        // Chat bubble settle-in — a message lifts into place once on arrival.
        'message-in': {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // Page-enter — content settles up into place on route change.
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'scale-in': 'scale-in 160ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'slide-up-and-fade': 'slide-up-and-fade 200ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'slide-down-and-fade': 'slide-down-and-fade 200ms cubic-bezier(0.23, 1, 0.32, 1) both',
        shimmer: 'shimmer 1.4s linear infinite',
        'mesh-drift': 'mesh-drift 24s ease-in-out infinite',
        'soft-pulse': 'soft-pulse 3.2s ease-in-out infinite',
        'slide-in-drawer':
          'slide-in-drawer 240ms cubic-bezier(0.32, 0.72, 0, 1) both',
        'message-in': 'message-in 260ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'rise-in': 'rise-in 320ms cubic-bezier(0.23, 1, 0.32, 1) both',
      },
      boxShadow: {
        // Elevation ramp for floating surfaces (soft, layered ambient+key).
        // NB: keys must not collide with color names (a `shadow-card` would
        // resolve as a shadow COLOR from the `card` token, not a box-shadow).
        soft: '0 1px 2px 0 oklch(var(--shadow-color) / 0.07), 0 4px 16px -6px oklch(var(--shadow-color) / 0.12)',
        float:
          '0 2px 6px 0 oklch(var(--shadow-color) / 0.08), 0 12px 32px -12px oklch(var(--shadow-color) / 0.18)',
      },
      spacing: {
        // Two editorial steps added to the default scale.
        18: '4.5rem',
        22: '5.5rem',
      },
      maxWidth: {
        prose: '68ch',
        shell: '1320px',
      },
    },
  },
  plugins: [],
};
