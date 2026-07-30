# Design

## Theme

Light by default. The physical scene is an agent at a desk in an office under
overhead fluorescent or daylight, the browser tab open all day. Light surfaces
match that ambient light; dark mode is available via `[data-theme='dark']` on
`<html>` for the minority of agents who prefer it.

## Color

OKLCH throughout. Token names follow shadcn semantic slots so primitives map
1:1 to community patterns.

**Brand color**: YIJI teal, vivid step — `oklch(0.58 0.125 192)` (derived
from house `#0F8D8F` by raising chroma at the same lightness, so contrast
math is unchanged). This is the tenant default referenced as `--primary`
everywhere. Per-tenant override via `--brand-primary` on `<html>`.

**Color strategy (revised 2026-07-29): MULTI-HUE VIVID.** Colour now carries
meaning across the whole product, not just the inbox. Teal remains the brand and
the only _identity_ colour, but status, priority and category each own a hue —
violet, coral, amber, emerald and the new `--sky` — and chroma is raised on every
accent. This supersedes the earlier "decorative color stays banned" rule at the
owner's direction.

**Contrast is solved numerically, not by eye.** OKLCH `L` is PERCEPTUAL
lightness, not WCAG luminance, so raising chroma at constant `L` silently drops
contrast — it took `--primary` from 4.61 to 4.31:1, under AA for the white button
labels it carries. Every accent that carries white text has its `L` solved to
clear 4.5:1. `--warning` stays light on purpose: its foreground is dark ink
(6.74:1), so darkening it would have made that pairing worse. Re-run the check
if you retune a hue.

_Superseded:_ **Committed on conversation surfaces, Restrained
elsewhere** (messenger-vibrant direction, user-approved 2026-07-23,
reference: modern messenger UIs). In the inbox/thread the brand teal
carries the outgoing message bubbles, the unread count badges, the send
button, and selection; incoming bubbles sit on the cool `--bubble`
periwinkle so the two directions read instantly. Colorful deterministic
avatar hues are part of the vibrancy. Outside conversation surfaces the
restrained rules still apply: CTAs default to near-black
(`--foreground`), decorative color stays banned.

### Surface ladder — why the canvas is tinted

Light does not mean flat. Cards are pure white and the canvas sits **below**
them, so content reads as elevated:

| Layer                             | L     | Where                               |
| --------------------------------- | ----- | ----------------------------------- |
| `--card`/`--popover`              | 1.000 | Content surfaces — stays pure white |
| `--background`                    | 0.965 | Workspace canvas behind them        |
| `--secondary`/`--muted`/`--input` | 0.935 | Hover, ghost buttons, form fields   |

Corrected 2026-07-29. The canvas was 0.985 against white cards — a 1.5%
difference, which is not a surface relationship, and every screen read as
washed out. Deepening the canvas on its own would have collided with the 0.96
hover tint and erased hover states, so the ladder moves as a unit; keep the
gaps roughly even if you retune it. Hairlines are 14% (24% for fields and
dividers) — enough to define an edge without drawing a box.

### Light tokens (default)

| Token                  | OKLCH                   | Role                                                              |
| ---------------------- | ----------------------- | ----------------------------------------------------------------- |
| `--background`         | `0.965 0.004 230`       | App canvas — tinted so white cards visibly float (mesh over this) |
| `--foreground`         | `0.20 0.005 250`        | Body text, charcoal with slight cool — also the default CTA fill  |
| `--card`               | `1 0 0`                 | White surface that floats above the tinted canvas                 |
| `--popover`            | `1 0 0`                 | Dropdowns, dialogs                                                |
| `--primary`            | `0.58 0.125 192`        | YIJI teal, vivid (or vendor `--brand-primary`)                    |
| `--primary-foreground` | `1 0 0`                 | Text on primary fills                                             |
| `--primary-subtle`     | `0.58 0.125 192 / 0.12` | Selected row, unread pill bg, brand-accent fills                  |
| `--bubble`             | `0.945 0.02 255`        | Incoming chat bubble — cool periwinkle vs the teal outgoing       |
| `--secondary`          | `0.935 0.006 230`       | Hover surface, ghost-button bg, soft tints                        |
| `--muted`              | `0.935 0.006 230`       | Same as secondary for impeccable-product simplicity               |
| `--muted-foreground`   | `0.46 0.010 250`        | Meta text, labels                                                 |
| `--destructive`        | `0.56 0.22 25`          | Error states, overdue SLA                                         |
| `--success`            | `0.58 0.15 155`         | Resolved status, responded marker                                 |
| `--warning`            | `0.70 0.16 70`          | Pending status, SLA warning                                       |
| `--border`             | `0.22 0.005 250 / 0.14` | Hairline at 14% opacity                                           |
| `--border-strong`      | `0.22 0.005 250 / 0.24` | Form fields, dividers under hover                                 |
| `--ring`               | `0.58 0.125 192`        | Focus ring — same as primary                                      |
| `--secondary-brand`    | `0.66 0.22 0`           | Coral pink — eyebrow pills, "new" badges, urgent priority         |
| `--display`            | `0.16 0.01 250`         | Punchier ink for hero typography (h1/h2 in PageHeader)            |
| `--rail`               | `0.22 0.045 196`        | Dark YIJI teal — the rail / nav sidebar                           |
| `--rail-foreground`    | `0.92 0.03 196`         | Off-white icons on the rail                                       |
| `--rail-active`        | `0.28 0.07 196`         | Rail hover/active bg — lighter step of the same hue               |

Tenant brand override: `--brand-primary` CSS variable on `<html>` (set at
runtime from vendor record) replaces `--primary` for that tenant. `#0F8D8F`
is the YIJI house default.

### Contrast verification

- `--foreground` on `--background`: ~14:1 (AAA)
- `--muted-foreground` on `--background`: ~5.1:1 (AA body, AAA large)
- `--primary` on `--background`: ~4.2:1 (AA large) — only used as fill
  behind `--primary-foreground` white text, never as body text on white
- `--primary-foreground` on `--primary`: ~4.6:1 (AA large for buttons)
- `--rail-foreground` on `--rail`: ~12:1 (AAA)

## Typography

System sans only. One family, weight contrast for hierarchy (per impeccable
product register: "One family is often right").

```css
font-family:
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  'Segoe UI',
  Roboto,
  'Helvetica Neue',
  Arial,
  sans-serif;
```

Arabic surfaces swap to `'Noto Sans Arabic', Tahoma, sans-serif` automatically
via `[dir='rtl'] body`.

### Scale (fixed rem, not fluid)

| Token       | Size / Line | Use                            |
| ----------- | ----------- | ------------------------------ |
| `text-2xs`  | 11px / 16px | Meta labels, count badges      |
| `text-xs`   | 12px / 18px | Secondary text, table headers  |
| `text-sm`   | 13px / 20px | Body, table cells, button text |
| `text-base` | 14px / 22px | Default body weight            |
| `text-md`   | 15px / 24px | Emphasized body                |
| `text-lg`   | 17px / 26px | Card titles                    |
| `text-xl`   | 19px / 28px | Page titles                    |
| `text-2xl`  | 22px / 30px | Hero / detail page title       |

Ratio between steps ≈ 1.15 (impeccable target 1.125–1.2). Letter-spacing on
display: `-0.01em` at xl, `-0.015em` at 2xl, `-0.02em` at 3xl+.

**No display font**, no serif accents, no font-pairing. Weight (500, 600) and
size carry hierarchy.

## Radius

Small. 8px (`--radius: 0.5rem`) for cards and inputs; 6px (`rounded-md`) for
buttons; 4px (`rounded-sm`) for tags; full (`rounded-full`) for status pills.
Per impeccable: pick one corner system and audit. The rule here is "buttons
6, cards/inputs 8, pills full" — applied consistently.

## Shadow

Practically invisible. Three steps:

- `shadow-xs`: `0 1px 0 0 oklch(var(--shadow-color) / 0.04)` (border-equivalent depth)
- `shadow-sm`: `0 1px 2px 0 oklch(var(--shadow-color) / 0.06)` (resting button)
- `shadow-md`: `0 4px 12px -2px oklch(var(--shadow-color) / 0.12)` (popover, dropdown)
- `shadow-lg`: `0 10px 30px -10px oklch(var(--shadow-color) / 0.24)` (modal only)

No decorative shadows on cards or list items.

## Spacing & layout

- Page chrome: 48px top header, 0 side margin (full-bleed three-pane layouts).
- List sidebar width: 340px on desktop.
- Detail max-width: 768px on focused-task pages (form-heavy: ticket detail,
  preferences). Full-bleed on the conversation thread.
- Row heights: 36px for inbox/ticket list items; 40px for table rows; 44px
  for header rows.
- Padding inside cards: 16–24px (`p-4` / `p-5` / `p-6` only — no in-between).
- Section gap on form-heavy pages: 32px (`space-y-8`).

## Motion

Emil Kowalski's curves and durations. Token names exposed via Tailwind:

```js
transitionTimingFunction: {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',     // entries
  'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)', // on-screen
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',    // iOS-style drawers
},
transitionDuration: {
  fast: '120ms',     // hover state
  base: '160ms',     // default
  medium: '200ms',   // dropdown enter
  slow: '240ms',     // modal enter
},
```

### Rules

- **Buttons** scale to `0.97` on `:active`, 160ms ease-out. The only animation
  agents see hundreds of times per day.
- **Popovers + dropdowns** scale-in from `0.96` opacity 0 → `1` opacity 1
  with `origin: trigger`. 200ms ease-out.
- **Modals** fade-in backdrop, scale-in from `0.96` (center origin since not
  trigger-anchored). 240ms ease-out.
- **Status pills** crossfade between tones via 160ms color transition only
  (no scale, no flash — agents change status constantly).
- **Inbox row select** has no animation at all (per Emil's frequency rule:
  100+/day → no animation).
- **Skeleton shimmer** for loading > 200ms only; spinner for shorter waits.
- **Reduced motion**: all `motion-safe:` gated transforms collapse to static;
  fades shorten to 80ms; the typing-dot pulse becomes solid dots.

## Components

The `@yiji/ui` package owns all primitives. Variant-based API (shadcn-style):

- `<Button variant="default|secondary|outline|ghost|destructive|link" size="sm|md|lg|icon" />`
- `<Input>`, `<Textarea>`, `<Select>` — same base classes via `fieldBase`
- `<FormField label hint error>` wraps any control + label + hint/error
- `<Card padding="none|sm|md|lg">` — borderless by default unless the section needs to be visually contained
- `<Pill tone="neutral|primary|success|warning|destructive|muted" dot>` — lowercase, never uppercase
- `<EmptyState title description action icon>`
- `<Spinner>` / `<Skeleton>`
- `<IconButton variant="ghost|secondary|outline" size="sm|md|lg" aria-label>`

### Anti-patterns (banned per impeccable)

- Side-stripe selection indicators (`before:w-0.5 before:bg-ink`) — banned.
- Uppercase tracked eyebrows above every section — max 1 per 3 sections.
- Em dashes (`—`) anywhere in user-visible strings — banned.
- Wrapping every section in a `<Card>` — cards earn their use.
- Decorative hover lifts (`hover:shadow-md` on list items) — banned.
- Spinners > 300ms — switch to skeleton.

## RTL

All layouts use Tailwind logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`,
`text-start`, `text-end`, `border-s`, `border-e`). No `pl-` / `mr-` / `text-left`
in any portal file. The `LanguageToggle` flips `dir` on `<html>` and i18next
re-renders.

## Live config

Vite SPA. HTML entries: `apps/agent-portal/index.html`, `apps/admin-portal/index.html`.
Live mode (`.impeccable/live/config.json`) not yet configured; can be set up
on first invocation of `/impeccable live`.
