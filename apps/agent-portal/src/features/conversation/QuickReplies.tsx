import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { cn, DISMISS_FIRST_ATTR } from '@yiji/ui';
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

/**
 * WHICH LIBRARY a ready-made line belongs to.
 *
 * Three separate sets, and they must not be pooled (ops, 2026-10-04: *"the
 * values in reason and action taken are new and isolated from each other and
 * the inbox quick replies"*). A chat reply is addressed to a CUSTOMER; a reason
 * explains why an order was late; an action says what was done about it. One
 * shared list would offer an agent mostly wrong answers in all three places,
 * which is how a convenience becomes a thing people scroll past.
 */
export type QuickReplyKind = 'chat' | 'late_order_reason' | 'late_order_action';

export interface QuickReply {
  id: string;
  label: string;
  text: string;
  lang: 'en' | 'ar';
  kind?: QuickReplyKind | null;
}

export function useQuickReplies(kind: QuickReplyKind = 'chat') {
  return useQuery({
    queryKey: ['quick-replies', kind],
    // The library changes when operations edit it, which is rarely.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      /*
       * READ WIDE, FILTER HERE — deliberately, and it is not laziness.
       *
       * Directus 403s a WHOLE query that names a column the collection does not
       * have, so filtering on `kind` server-side would make every library in
       * every portal return nothing on any environment where the field has not
       * been created yet — and `catch` below would swallow it into an empty
       * list that looks exactly like "operations have not written any". That is
       * the silent-empty-failure shape this codebase keeps producing, and a
       * schema field does NOT travel through a deploy.
       *
       * So the field is requested but never filtered on: an environment without
       * it returns rows whose `kind` is undefined, which the fallback below
       * reads as `chat` — where every existing row came from.
       */
      try {
        const rows = (await directus.request(
          readItems(
            'quick_replies' as never,
            {
              filter: { active: { _eq: true } },
              fields: ['id', 'label', 'text', 'lang', 'kind'],
              sort: ['sort', 'label'],
              limit: -1,
            } as never,
          ),
        )) as unknown as QuickReply[];
        return rows.filter((r) => (r.kind ?? 'chat') === kind);
      } catch {
        /*
         * A FIRST ATTEMPT THAT NAMES `kind` CAN STILL 403 on an environment
         * where the field is missing, so retry WITHOUT it rather than returning
         * nothing: the inbox had this library long before the two late-order
         * ones existed and must keep working while the field is rolled out.
         */
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
          /* Without the column there is one undifferentiated library, and it is
             the chat one. The late-order boxes correctly show nothing. */
          return kind === 'chat' ? rows : ([] as QuickReply[]);
        } catch {
          // No library configured (or no permission) is not an error worth
          // interrupting a chat for — the row simply does not appear.
          return [] as QuickReply[];
        }
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
  kind = 'chat',
  className,
  dismissSearchOnOutside = false,
  floatAbove = false,
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
  /**
   * WHICH LIBRARY to offer. Defaults to the inbox's, so every existing caller
   * is unchanged. The late-order decision box passes its own two.
   */
  kind?: QuickReplyKind;
  className?: string;
  /**
   * Let an outside press close the list EVEN WHILE a "/" search holds it open.
   *
   * Off in the inbox, where the composer owns a search and the list must stay
   * up as the agent types beside it. On in the late-order decision box (owner,
   * 2026-10-05): the first press anywhere but the list puts the list away, and
   * the dialog around it closes only on a second — see `DISMISS_FIRST_ATTR`.
   * Typing again reopens it.
   */
  dismissSearchOnOutside?: boolean;
  /**
   * Open the list UPWARD, floating above the control and free to extend past
   * the dialog it sits in (owner, 2026-10-06, start-chat first message: "place
   * it on top of the first message box… it could exceed the popup from the
   * top… there is no rule for it to stay within the popup"). Rendered in a
   * portal so the dialog's edge cannot clip it. Off everywhere else, where the
   * list stays in the flow and never covers the input.
   */
  floatAbove?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const replies = useQuickReplies(kind);
  const [open, setOpen] = useState(false);
  /** The whole control — trigger, language toggle and panel — for click-outside. */
  const wrap = useRef<HTMLDivElement>(null);
  /** The floating list lives in a portal, outside `wrap`, so it needs its own
      ref for click-outside — otherwise a click on a reply would count as
      "outside" and close the list before the pick lands. */
  const floating = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
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
  /*
   * A SEARCH THE AGENT PUT AWAY stays away until they type again: the key is
   * the search as it stood when dismissed, so the next keystroke differs from
   * it and reopens the list without any extra state to reset.
   */
  const searchKey = `${searching ? 1 : 0}|${query}`;
  const [dismissedSearch, setDismissedSearch] = useState<string | null>(null);
  const searchOpen = (!!searching || !!query) && dismissedSearch !== searchKey;
  const listOpen = open || searchOpen;

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
  const dismissable = open || (dismissSearchOnOutside && searchOpen);
  useEffect(() => {
    if (!dismissable) return;
    const close = () => {
      setOpen(false);
      if (dismissSearchOnOutside) setDismissedSearch(searchKey);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrap.current?.contains(target) && !floating.current?.contains(target)) close();
    };
    /* Escape too — the panel is a listbox and that is the expected key. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [dismissable, dismissSearchOnOutside, searchKey]);

  /* FLOATING: track where the control is, so the list sits just above it and
     follows a scroll or resize instead of drifting away. */
  useEffect(() => {
    if (!floatAbove || !listOpen) return;
    const measure = () => setAnchor(wrap.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [floatAbove, listOpen]);

  /* How many exist at all, so the toggle can say when a language is empty
     rather than looking broken. */
  const total = replies.data?.length ?? 0;
  if (total === 0) return null;

  const pick = (r: QuickReply) => {
    onPick(fillPlaceholders(r.text, vars));
    setOpen(false);
  };

  /* WHAT THE BUTTON IS CALLED, per library. "Quick replies" is right above a
     composer and wrong above a reason box — nothing there is a reply to a
     customer, and a mislabelled control is one an agent learns to ignore. */
  const openLabel =
    kind === 'late_order_reason'
      ? t('quickReplies.openReasons', { defaultValue: 'Ready reasons' })
      : kind === 'late_order_action'
        ? t('quickReplies.openActions', { defaultValue: 'Ready actions' })
        : t('quickReplies.open', { defaultValue: 'Quick replies' });

  const list = (
    <div
      role="listbox"
      aria-label={openLabel}
      /* Tells a dialog around it that the next outside press is ours. */
      {...{ [DISMISS_FIRST_ATTR]: '' }}
      /*
       * IN THE FLOW, NEVER FLOATING OVER THE INPUT (owner, 2026-10-05).
       *
       * It was an overlay (`absolute bottom-full`) opening upward. Where
       * the buttons sit BELOW a text box — a late-order reason or action,
       * the first message of an agent-started chat — that put the list
       * squarely over the box, so the agent could not see what they were
       * typing; inside the start-chat dialog the overlay was also clipped
       * by the dialog's edge, hiding replies.
       *
       * Now it takes its own space directly under its buttons and pushes
       * what follows down. In the inbox composer the buttons sit above the
       * text box, so the list lands between them — above the input, not on
       * it. Capped and scrollable so a long library stays reachable.
       */
      className={cn(
        'w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl border border-border/80 bg-popover p-1.5 ring-1 ring-foreground/[0.04]',
        floatAbove ? 'shadow-float' : 'mt-2 max-h-64 shadow-sm',
      )}
      /* Floating: as tall as the room above the control allows. */
      style={floatAbove && anchor ? { maxHeight: Math.max(160, anchor.top - 16) } : undefined}
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
  );

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setDismissedSearch(null);
            setOpen((v) => !v);
          }}
          aria-expanded={listOpen}
          aria-haspopup="listbox"
          className="shrink-0 rounded-full border border-dashed border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:border-solid hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
        >
          {openLabel}
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

      {listOpen && !floatAbove && list}
      {listOpen &&
        floatAbove &&
        anchor &&
        createPortal(
          <div
            ref={floating}
            /* Above the dialog (z-50), anchored to the control's top edge and
               growing upward, so it may cover the phone field and pass the
               dialog's top — never the box being typed in, which is below. */
            className="fixed z-[70]"
            style={{
              left: anchor.left,
              width: Math.min(anchor.width, 512),
              bottom: window.innerHeight - anchor.top + 8,
            }}
          >
            {list}
          </div>,
          document.body,
        )}
    </div>
  );
}
