import { useMemo, useState } from 'react';
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
): QuickReply[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? replies.filter((r) => `${r.label} ${r.text}`.toLowerCase().includes(q))
    : [...replies];
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
  vars,
  onPick,
  className,
}: {
  /** What the customer has written, for language ranking. */
  customerText: string;
  /** The live "/…" filter from the composer, or ''. */
  query: string;
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
  const [showAll, setShowAll] = useState(false);

  const ranked = useMemo(
    () => rankReplies(replies.data ?? [], customerText, query, i18n.language),
    [replies.data, customerText, query, i18n.language],
  );

  if (ranked.length === 0) return null;

  // Five without a search, more once the agent is looking for something —
  // a row that scrolls past the fold is a row nobody reaches the end of.
  const shown = showAll || query ? ranked : ranked.slice(0, 5);
  const hidden = ranked.length - shown.length;

  return (
    <div className={cn('flex items-center gap-1.5 overflow-x-auto pb-1', className)}>
      {query && (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {t('quickReplies.filtering', { defaultValue: 'matching' })}
        </span>
      )}
      {shown.map((r) => (
        <button
          key={r.id}
          type="button"
          dir="auto"
          // The full text on hover: a label alone does not say what will land
          // in the box, and an agent should never send something unseen.
          title={fillPlaceholders(r.text, vars)}
          onClick={() => onPick(fillPlaceholders(r.text, vars))}
          className="shrink-0 whitespace-nowrap rounded-full border border-dashed border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:border-solid hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
        >
          {r.label}
        </button>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="shrink-0 whitespace-nowrap rounded-full border border-border px-2.5 py-1 text-2xs font-semibold text-foreground transition-colors duration-fast hover:bg-secondary"
        >
          {t('quickReplies.more', { defaultValue: '⋯ all {{n}}', n: ranked.length })}
        </button>
      )}
      {showAll && !query && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="shrink-0 rounded-full px-2 py-1 text-2xs text-muted-foreground hover:text-foreground"
          aria-label={t('quickReplies.fewer', { defaultValue: 'Show fewer' })}
        >
          ✕
        </button>
      )}
    </div>
  );
}
