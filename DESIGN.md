# Design

## Theme

**FLUID DARK by default (2026-08-14, owner-directed from reference designs).**
Near-black canvas (`--canvas 0.13`), elevated charcoal cards (`0.19`),
hairlines as low-alpha white, the jade accent lifted to glow (`0.75 0.115
185`). Light remains available via `[data-theme='light']` and keeps the
palette below.

**Navigation is a floating TOP bar — no sidebars (owner's explicit call,
2026-08-14: "we need no sidebars. we need it on top").** One rounded,
hairlined bar on the canvas in BOTH portals: brand at the start, text-pill
navigation in the middle (rounded-full, no per-pill icons; active = jade wash
`bg-primary/15 text-primary` with an inset hairline), utilities and the user
chip at the end. Admin's multi-item sections collapse to ARIA menu-button
dropdowns rendered as elevated dark panels with tinted icon chips. The
vertical rail exists only as the mobile (<lg) drawer. KPI cards carry an icon
in a tinted square chip (`bg-<hue>-tint text-<hue>`; the warning hue is
excluded — its glyph on the tint fails 3:1 in light). A sidebar rail shipped
for a few hours on 2026-08-14 and was reversed the same day at the owner's
direction — do not reintroduce it without new owner input.

_Superseded default:_ Light by default. The physical scene is an agent at a desk in an office under
overhead fluorescent or daylight, the browser tab open all day. Light surfaces
match that ambient light; dark mode is available via `[data-theme='dark']` on
`<html>` for the minority of agents who prefer it.

## Color

OKLCH throughout. Token names follow shadcn semantic slots so primitives map
1:1 to community patterns.

**Brand color (2026-08-21): SARA CRM indigo — `oklch(0.477 0.223 278)`,
i.e. `#4B3BD5`.** Taken FROM the logo, not chosen beside it. The mark is the
fixed point and `--primary` is derived from it, which is what stops the two
from drifting apart the next time either is touched.

The rule that follows from this: **every hue in the CRM's own palette stays
within ~35° of 278.** `--violet` 285, `--sky` 250, and the ink/rail neutrals
all sit inside that band. A hue further out stops reading as an accent and
starts reading as a second brand — the teal at 192 that used to be `--primary`
is exactly what that looked like once the indigo mark sat on top of it.

Two carve-outs, both deliberate:

- **Semantic hues** (`--success`, `--warning`, `--destructive`) are exempt.
  They mean something, and pulling them toward the brand would cost the
  meaning. Green stays green.
- **The chat widget** is exempt entirely. It wears the TENANT's brand via
  `--brand-primary`, so on a Yiji deployment it is still teal `#0F8D8F` with
  the Yiji mark. `VendorsPage`'s `#0F8D8F` default is the vendor's colour,
  not ours — do not "fix" it to indigo.

_Superseded:_ **Brand color**: YIJI teal, vivid step — `oklch(0.58 0.125 192)`
(derived from house `#0F8D8F`). Correct while the product was Yiji-branded;
the CRM is Sara CRM now and carries its own mark.

**Color strategy (revised 2026-08-13, owner's direction): OBSIDIAN + JADE.**
A flagship register: ONE refined accent (jade, `oklch(0.50 0.115 190)` — the
brand teal deepened until it reads expensive rather than default-SaaS), ink
CTAs (`--display` solid; the cyan→violet gradient button is gone and must not
return), a deeper obsidian rail (`0.21 0.03 200`), and semantic hues
desaturated to sophistication (they still mean things; they no longer shout).
Display type is Outfit Variable on `h1/h2` and `font-display`; body stays
Inter for dense data. A fixed 1.4% grain overlay breaks digital flatness.
Contrast still solved numerically — every accent carrying white text clears
4.5:1. This supersedes MULTI-HUE VIVID below at the owner's explicit request
("complete transformation… billion-dollar app"; not the ops portal's look).

_Superseded:_ **Color strategy (revised 2026-07-29): MULTI-HUE VIVID.** Colour now carries
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

### KPI tiles — colour as accent, never as surface (settled 2026-08-04)

The canonical stat/KPI tile is a **white card, ink numeral, coloured
state dot**:

```
container  bg-card ring-1 ring-border shadow-soft rounded-2xl
numeral    text-4xl font-bold text-foreground tabular-nums
label      text-2xs uppercase text-muted-foreground, preceded by
           an h-1.5 w-1.5 rounded-full dot in the metric's hue
```

This went through both failure modes before landing here, so don't reopen them:

- **Pale washes** (low-alpha tints of dark accents) read as a wireframe —
  rejected as "not vibrant".
- **Solid saturated fills** (bg-success etc. with white numerals) read as a toy
  dashboard — rejected as "childish", and full-saturation colour on an inactive
  display is a product-register ban. That pass also twice produced invisible
  numerals (accent-on-same-accent), a class of bug no type check can see.

Ink-on-white is also simply the strongest contrast available (~19.5:1 vs
4.5–6.5:1 for white-on-colour). Colour still identifies the metric — as a
state-indicator dot, which is what SLA green/amber/red actually is. No coloured
glow shadows on tiles; `shadow-soft` only.

### Tint ramp — how a coloured surface is built

A coloured surface is **three tokens, not one alpha**:

| Part    | Token          | Example           |
| ------- | -------------- | ----------------- |
| fill    | `--<hue>-tint` | `bg-success-tint` |
| edge    | accent @ ~35%  | `ring-success/35` |
| numeral | accent         | `text-success`    |

Do NOT fake the fill with a low alpha of the accent. `bg-success/18` is 18% of a
_dark_ green over white, which reads grey-green and washed out — that mistake is
why the stat tiles twice looked paler after a "more vibrant" pass. The tint
tokens are high-lightness / mid-chroma, so they read unmistakably coloured while
staying quiet enough to carry dark text.

Accent-on-tint lands ~3.7–3.9:1, which is AA for LARGE text only. That is fine
for the display numerals these tiles use (`text-3xl`+) and NOT fine for body
copy — never put small text in the accent colour on a tint fill; use
`--foreground` or `--muted-foreground` there.

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

Generated from `apps/agent-portal/src/index.css`, which is the source of truth
— the admin portal mirrors it. This table drifted badly once (it still named
the teal brand two brand changes later), so treat any disagreement between it
and the stylesheet as the table being wrong.

| Token                  | OKLCH                   | Role                                                            |
| ---------------------- | ----------------------- | --------------------------------------------------------------- |
| `--background`         | `0.98 0.003 250`        | App canvas — tinted so white cards visibly float                |
| `--canvas`             | `0.972 0.004 252`       | The step below background, for inset wells                      |
| `--foreground`         | `0.25 0.02 260`         | Body text — charcoal with a slight cool bias                    |
| `--card`               | `1 0 0`                 | White surface floating above the canvas                         |
| `--primary`            | `0.477 0.223 278`       | **SARA CRM indigo (`#4B3BD5`)** — 7.28:1 on white               |
| `--primary-strong`     | `0.42 0.223 278`        | Pressed/hover step of primary                                   |
| `--primary-foreground` | `1 0 0`                 | Text on primary fills                                           |
| `--primary-subtle`     | `0.477 0.223 278 / 0.1` | Selected row, unread pill bg, brand-accent fills                |
| `--brand`              | `0.477 0.223 278`       | The logo's own colour — same value, named for intent            |
| `--ink`                | `0.23 0.035 278`        | Masthead / table headers — on the brand hue, not a stray navy   |
| `--ink-muted`          | `0.7 0.02 278`          | Secondary text on ink surfaces                                  |
| `--secondary`          | `0.955 0.006 252`       | Hover surface, ghost-button bg                                  |
| `--muted-foreground`   | `0.55 0.02 262`         | Meta text, labels                                               |
| `--destructive`        | `0.58 0.21 27`          | Error states, overdue SLA (semantic — exempt from the hue band) |
| `--success`            | `0.68 0.16 157`         | Resolved status (semantic — exempt)                             |
| `--warning`            | `0.75 0.16 65`          | Pending status, SLA warning (semantic — exempt)                 |
| `--border`             | `0.25 0.02 260 / 0.08`  | Hairline at 8% opacity                                          |
| `--ring`               | `0.477 0.223 278`       | Focus ring — same as primary                                    |
| `--rail`               | `0.23 0.035 278`        | The nav rail — same value as `--ink`                            |
| `--rail-deep`          | `0.19 0.035 278`        | Rail's darker step                                              |
| `--rail-active`        | `0.55 0.2 278`          | Rail hover/active fill — 5.19:1 with white                      |
| `--display`            | `0.477 0.223 278`       | Hero typography — the brand indigo, not ink                     |
| `--violet`             | `0.55 0.17 285`         | Data hue, 7° off brand                                          |
| `--sky`                | `0.72 0.14 250`         | Data hue, 28° off brand                                         |
| `--secondary-brand`    | `0.6 0.19 20`           | Coral — eyebrow pills, "new" badges                             |

**TINT RAMP** — `--primary-tint` `0.93 0.055 278`, `--sky-tint` `0.93 0.06 250`,
`--violet-tint` `0.94 0.05 285`, plus the three semantic tints. These are
separate tokens, never an alpha of the accent (an alpha of a dark hue reads
grey). **Each tint sits on its own accent's hue** — when `--sky` moved to 250
and its tint was left behind at 205, one KPI card silently stayed teal through
a whole rebrand.

**Numerals are the exception to the token rule.** `KPI_NUMERALS` in
`ComplaintDashboard.tsx` hardcodes `oklch(...)` literals because the chip hues
are tuned to fill a chip and miss 4.5:1 as a 44px numeral. Only the LIGHTNESS
is meant to differ from the token — keep the hue in step when the brand moves.

Tenant brand override: `--brand-primary` CSS variable on `<html>` (set at
runtime from the vendor record) replaces `--primary` for that tenant. `#0F8D8F`
is the YIJI house default. This applies to the **chat widget only** — the
customer-facing surface wears the tenant's brand. The two staff portals are
Sara CRM's own product and always carry the indigo above; they are not
tenant-themable.

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
