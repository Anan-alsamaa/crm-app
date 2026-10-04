import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { cn } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Ready-made replies, one click above the composer.
 *
 * Taken from the operations portal, where agents already work this way: the row
 * of chips sits directly above the box, and the common answer is one click
 * rather than one paragraph retyped forty times a day — and typed the same way
 * every time, which is the half that matters to a customer reading two replies
 * from two agents.
 *
 * Three behaviours carried over deliberately:
 *
 *  - RANKED BY THE CUSTOMER'S LANGUAGE, judged from what the customer wrote
 *    rather than from what we sent. An Arabic template we sent earlier must not
 *    make an English conversation look Arabic.
 *  - PLACEHOLDERS filled at click time from this conversation, so "your order
 *    {order}" arrives as a real number rather than as a hole the agent has to
 *    remember to fill.
 *  - "/" FILTERS as you type, because past a handful of replies a scrolling row
 *    is slower than typing the thing out.
 *
 * What is NOT carried over: the ops portal REPLACES whatever is in the box.
 * Here a click inserts, so a half-written reply is never destroyed by a
 * mis-click — the one thing that would stop an agent trusting the row.
 */

/** Arabic range — enough to tell which language a message is in. */
const AR = /[\u0600-\u06FF]/;

/** What the language selector can be set to. `all` shows both. */
export type ReplyLang = 'all' | 'en' | 'ar';

/**
 * Which language to OFFER for this conversation, before the agent chooses.
 *
 * From what the CUSTOMER wrote, not from what we sent: an Arabic template we
 * used earlier must not make an English conversation look Arabic. With nothing
 * written yet there is nothing to infer from, so both are shown rather than
 * guessing and hiding half the list.
 */
export function defaultReplyLang(customerText: string): ReplyLang {
  if (!customerText.trim()) return 'all';
  return AR.test(customerText) ? 'ar' : 'en';
}

export interface QuickReply {
  id: string;
  label: string;
  text: string;
  lang: 'en' | 'ar';
}

export function useQuickReplies() {
  return useQuery({
    queryKey: ['quick-replies'],
    // The library changes when operations edit it, which is rarely.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      try {
        const rows = (await directus.request(
          readItems(
            'quick_replies' as never,
            {
              filter: { active: { _eq: true } },
              fields: ['id', 'label', 'text', 'lang'],
              sort: ['sort', 'label'],
              limit: -1,
            } as never,
          ),
        )) as unknown as QuickReply[];
        return rows;
      } catch {
        // No library configured (or no permission) is not an error worth
        // interrupting a chat for — the row simply does not appear.
        return [] as QuickReply[];
      }
    },
  });
}

/** Fill {order} / {name} / {brand} / {restaurant} from this conversation. */
export function fillPlaceholders(
  text: string,
  vars: {
    order?: string | null;
    name?: string | null;
    brand?: string | null;
    restaurant?: string | null;
  },
): string {
  return text
    .replace(/\{order\}/g, vars.order ?? '')
    .replace(/\{name\}/g, vars.name ?? '')
    .replace(/\{brand\}/g, vars.brand ?? '')
    .replace(/\{restaurant\}/g, vars.restaurant ?? '');
}

/**
 * Replies in a useful order: the agent's own language first, then the
 * customer's, then by label.
 *
 * The portal language leads because switching it is a deliberate act — an agent
 * working in Arabic wants the Arabic buttons within reach, and ranking by the
 * thread instead left them below the fold behind "all 8" on every English
 * thread. It is the same precedence the reply drafter uses: an explicit choice
 * by the agent beats what the thread happens to be written in.
 *
 * Ordering only. Nothing is hidden — the other language is one click away, so
 * an agent answering an English customer from an Arabic portal still has the
 * English wording, just not first.
 *
 * `customerText` is what the CUSTOMER has written — see the note above on why
 * it is not the whole transcript.
 */
export function rankReplies(
  replies: readonly QuickReply[],
  customerText: string,
  query: string,
  uiLocale?: string,
  /*
   * WHICH LANGUAGE TO SHOW — 'all' keeps the old ordering-only behaviour.
   *
   * Ranking alone was not enough in practice (ops, 2026-10-03): with replies in
   * both languages the right one is first but the list is still half wrong, and
   * an agent scanning it reads past Arabic to reach English. Filtering answers
   * "show me only what I can send this customer".
   */
  lang: ReplyLang = 'all',
): QuickReply[] {
  const q = query.trim().toLowerCase();
  const byLang = lang === 'all' ? replies : replies.filter((r) => r.lang === lang);
  const filtered = q
    ? byLang.filter((r) => `${r.label} ${r.text}`.toLowerCase().includes(q))
    : [...byLang];
  const arabicConversation = AR.test(customerText);
  const arabicAgent = uiLocale ? uiLocale.toLowerCase().startsWith('ar') : null;
  return filtered.sort((a, b) => {
    if (arabicAgent !== null) {
      const ap = (a.lang === 'ar') === arabicAgent;
      const bp = (b.lang === 'ar') === arabicAgent;
      if (ap !== bp) return ap ? -1 : 1;
    }
    const am = (a.lang === 'ar') === arabicConversation;
    const bm = (b.lang === 'ar') === arabicConversation;
    if (am !== bm) return am ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function QuickReplies({
  customerText,
  query,
  searching,
  vars,
  onPick,
  className,
}: {
  /** What the customer has written, for language ranking. */
  customerText: string;
  /** The live "/…" filter from the composer, or ''. */
  query: string;
  /**
   * Whether the composer is in "/" SEARCH MODE at all.
   *
   * Separate from `query` because a bare `/` is an empty query and still has to
   * open the list — testing `!!query` meant the panel stayed shut until a
   * second character arrived (ops, 2026-10-04).
   */
  searching?: boolean;
  vars: {
    order?: string | null;
    name?: string | null;
    brand?: string | null;
    restaurant?: string | null;
  };
  /** Called with the filled text. The caller decides how to insert it. */
  onPick: (text: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const replies = useQuickReplies();
  const [open, setOpen] = useState(false);
  /** The whole control — trigger, language toggle and panel — for click-outside. */
  const wrap = useRef<HTMLDivElement>(null);
  /*
   * THE LANGUAGE THE AGENT IS BROWSING — seeded from the customer, then theirs.
   *
   * `null` means "not chosen yet", so the default keeps following the
   * conversation as the customer writes. Once the agent picks, their choice
   * sticks: a customer who types one English word must not swap the list out
   * from under someone mid-scan.
   */
  const [lang, setLang] = useState<ReplyLang | null>(null);
  const effectiveLang = lang ?? defaultReplyLang(customerText);

  const ranked = useMemo(
    () => rankReplies(replies.data ?? [], customerText, query, i18n.language, effectiveLang),
    [replies.data, customerText, query, i18n.language, effectiveLang],
  );
  /*
   * Typing `/` in the composer IS the search, so the list opens itself.
   *
   * `searching` rather than `!!query`: a bare `/` is an empty query and must
   * still open the list with everything in it (ops, 2026-10-04).
   */
  const listOpen = open || !!searching || !!query;

  /*
   * CLICKING AWAY CLOSES IT (ops, 2026-10-04).
   *
   * There was no dismiss at all: the panel opened on the button and the only
   * way back out was the button again or picking a reply — so an agent who
   * opened it to look, then went to type, was left with the list covering the
   * thread.
   *
   * Only while OPEN, and only for a press that lands outside the whole control
   * — the language toggle lives inside it and flipping Arabic/English must not
   * close the thing you are reading. `pointerdown`, not `click`: a press that
   * starts outside should dismiss even if the pointer travels before release,
   * which is how a real mis-click behaves.
   *
   * A `/` search is NOT dismissed this way — the composer owns that, and the
   * list must stay up while the agent types into the box next to it.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    /* Escape too — the panel is a listbox and that is the expected key. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* How many exist at all, so the toggle can say when a language is empty
     rather than looking broken. */
  const total = replies.data?.length ?? 0;
  if (total === 0) return null;

  const pick = (r: QuickReply) => {
    onPick(fillPlaceholders(r.text, vars));
    setOpen(false);
  };

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={listOpen}
          aria-haspopup="listbox"
          className="shrink-0 rounded-full border border-dashed border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:border-solid hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
        >
          {t('quickReplies.open', { defaultValue: 'Quick replies' })}
          <span className="ms-1 opacity-60">{ranked.length}</span>
        </button>

        {/* ARABIC / ENGLISH / BOTH. A segmented control rather than a dropdown:
            three options an agent flips between all day should cost one click,
            not two. */}
        <div className="flex shrink-0 items-center rounded-full border border-border p-0.5">
          {(['ar', 'en', 'all'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setLang(opt)}
              aria-pressed={effectiveLang === opt}
              className={cn(
                'rounded-full px-2 py-0.5 text-2xs font-medium transition-colors duration-fast',
                effectiveLang === opt
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt === 'all'
                ? t('quickReplies.langAll', { defaultValue: 'Both' })
                : opt === 'ar'
                  ? 'عربي'
                  : 'EN'}
            </button>
          ))}
        </div>

        {/* `searching`, not `query`: a bare `/` has opened the list and the
            agent should be told the box is now a search, BEFORE they have typed
            anything to match on. */}
        {searching && (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {query
              ? t('quickReplies.filtering', { defaultValue: 'matching' })
              : t('quickReplies.typeToSearch', { defaultValue: 'type to search' })}
          </span>
        )}
      </div>

      {listOpen && (
        <div
          role="listbox"
          aria-label={t('quickReplies.open', { defaultValue: 'Quick replies' })}
          /* ABOVE the composer, not below: the composer is already at the
             bottom of the window, so a menu that opens downward opens
             off-screen. Capped and scrollable so a long list is reachable
             instead of being cut to the first five. */
          /* A CARD, not a strip. More room to breathe and a softer shadow, so
             the panel reads as a surface floating over the thread rather than
             as part of the composer. */
          className="absolute bottom-full z-30 mb-2 max-h-80 w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl border border-border/80 bg-popover p-1.5 shadow-float ring-1 ring-foreground/[0.04]"
        >
          {ranked.length === 0 ? (
            <p className="px-2 py-3 text-2xs text-muted-foreground">
              {t('quickReplies.noneInLang', {
                defaultValue: 'No replies in this language. Try Both.',
              })}
            </p>
          ) : (
            ranked.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={false}
                dir="auto"
                onClick={() => pick(r)}
                /*
                 * ONE REPLY = ONE CARD, and it has to LOOK like one.
                 *
                 * Every row used to be `text-2xs` on both lines with nothing
                 * between them, so a panel of replies read as a single slab of
                 * grey and an agent could not tell where one ended (owner,
                 * 2026-10-04). Three things separate them now: a hairline
                 * between siblings, real padding, and a hover state that lifts
                 * the whole card rather than tinting a line of text.
                 */
                className={cn(
                  'group block w-full rounded-lg px-3 py-2.5 text-start',
                  'border border-transparent',
                  'transition-colors duration-fast ease-out',
                  'hover:border-primary/25 hover:bg-primary/[0.05]',
                  'focus:outline-none focus-visible:border-primary/40 focus-visible:bg-primary/[0.05]',
                  /* The divider lives on the row ABOVE, so the last card has no
                     trailing line and the list ends cleanly. */
                  '[&:not(:last-child)]:mb-0.5',
                  'relative after:absolute after:inset-x-3 after:-bottom-px after:h-px',
                  'after:bg-border/60 last:after:hidden hover:after:opacity-0',
                )}
              >
                {/* THE LABEL leads: bigger, darker, and the thing an agent
                    scans for. It was the same size as the body, which is why
                    nothing stood out. */}
                <span className="block text-xs font-semibold leading-tight text-foreground">
                  {r.label}
                </span>
                {/* THE WHOLE TEXT, not a tooltip. An agent should never send
                    something they have not read, and a `title` is invisible on
                    a touch screen and to anyone using a keyboard. Clamped to
                    three lines so one long reply cannot push the rest out of
                    view — the full text still arrives in the composer. */}
                <span className="mt-1 line-clamp-3 block whitespace-pre-wrap text-2xs leading-relaxed text-muted-foreground">
                  {fillPlaceholders(r.text, vars)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
