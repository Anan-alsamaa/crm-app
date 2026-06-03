# Product

## Register

product

## Users

Customer support agents (the primary user) live in this tool for full shifts.
They juggle 50–200 conversations, tickets, and SLA deadlines per day across
multiple channels (web widget, email, future WhatsApp). The tool is open in
a browser tab continuously. They are not browsing — they are working.

Admins are the secondary user. They configure teams, SLA policies, and user
accounts a few times a week. They do not stare at the admin portal for hours.

The product also has a third surface — the chat widget — that customers see on
vendor websites. It is a separate aesthetic problem (consumer-facing on a host
site, branded per tenant) and out of scope for this PRODUCT.md.

## Product Purpose

Yiji CRM is the centralized internal customer-support tool for an organization
running multiple vendor brands. One inbox for every conversation across every
channel, one ticket system tracking work against SLAs, one source of truth for
contact history, and one place an admin can shape the policies that govern all
of it. Built so agents can resolve the next conversation without context-switching.

Success looks like: an agent never thinks about the UI, because the UI never
gets in the way of the conversation.

## Brand Personality

Calm, competent, customer-support-native. Tawk.to and Front are the closest
references — friendly enough that you trust it with a customer's bad day,
quiet enough that you can stare at it for eight hours without fatigue. Three
words: **clear, dependable, unobtrusive**.

The brand color (kinpaku gold per tenant default, or the vendor's brand color
when overridden) is rare on the page. The page is almost monochrome. Color
shows up where it earns attention: an unread conversation, an overdue SLA,
the primary CTA. Everything else lives in a tight neutral ramp.

## Anti-references

- **Warm-cream editorial** (the first failed iteration here): `oklch(0.97 0.005 80)` paper backgrounds, tiny uppercase eyebrows above every section, serif display fonts in a working tool. Reads as a magazine, not an app.
- **Dark lacquer luxury** (the second failed iteration here): kinpaku gold on near-black surfaces. Looks like a theatrical hotel website. Wrong physical scene for an 8h/day workspace.
- **Bootstrap-y blue-and-white admin templates**: heavy borders on every card, drop shadows on every panel, modal-as-first-thought, pagination dropdowns instead of inline interactions. Reads as "I downloaded a template."
- **Intercom's heavy chrome**: rounded chunky buttons, illustrated empty states with people in them, conversational micro-copy ("Looks like nothing's here!"). Too friendly for the work register.
- **Salesforce / SAP enterprise grid**: dense data tables with no whitespace, gray-on-gray-on-gray, every form field with the same weight. Reads as "compliance software."

## Design Principles

1. **The work is the design.** Every pixel competes with the agent's conversation. If a divider, a label, or a margin doesn't help the agent finish the next reply, it goes. Cards, eyebrows, decorative chrome — cut.
2. **One accent, locked.** A single brand color carries primary CTAs, current selection, focus rings, and unread state. Semantic colors (success, warning, destructive) stay separate and rare. No decorative use of color anywhere else.
3. **Earned familiarity over invention.** Use the patterns operators already know from tawk.to, Front, Linear, Stripe Dashboard. The top bar is a top bar. The left rail is a left rail. The list-of-things is on the left, the detail is on the right. No reinvention of standard affordances.
4. **Density is a feature.** Tight row heights (32–44px), tabular numbers for counts and timestamps, no oversized cards. Whitespace is for sections, not for individual rows.
5. **Motion conveys state, not personality.** Sub-200ms transitions on real state changes (status pill flip, send-message echo, inbox row select). No orchestrated page-load animation, no decorative hover lifts, no "AI sparkle." If an agent sees an animation 100+ times per day, it shouldn't exist.

## Accessibility & Inclusion

- WCAG AA minimum across both portals; AAA where reasonable for body text.
- Full keyboard navigation: tab order matches reading order, focus rings are 2px and visible in light + dark.
- RTL: Arabic (EN/AR toggle in the header). All layouts use logical properties (`ms-/me-/ps-/pe-/text-start/text-end`).
- `prefers-reduced-motion` honored everywhere — typing-dot indicator, fade-ins, scale-on-press all collapse to static.
- Color is never the sole signal: status pills carry dot + text, SLA overdue uses red + bold, never just red.
- Tested on 1280px and 1440px (the realistic agent workstation), graceful collapse below that.
