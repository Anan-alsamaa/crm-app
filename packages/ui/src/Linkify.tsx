import type { JSX } from 'react';
import { Fragment } from 'react';

/**
 * Message text with its links made clickable (owner, 2026-09-30).
 *
 * A customer pasting an order-tracking URL, and an agent sending one back, both
 * rendered as plain text — so the other side had to select and copy it by hand.
 *
 * NOT `dangerouslySetInnerHTML`. Message bodies are whatever a customer typed,
 * so they are untrusted: building HTML from them would make every chat an
 * injection surface. This splits the text and returns React nodes, which React
 * escapes for us.
 */

/*
 * WHAT COUNTS AS A LINK.
 *
 * `https?://…` and bare `www.…`, plus `mailto:`. Deliberately NOT every
 * dot-separated word: a sentence ending "…arrived at 6.30pm" or an Arabic
 * message containing a decimal would otherwise sprout links, and a false link in
 * a customer conversation is worse than a missed one.
 *
 * The trailing-character class excludes `.,;:!?` and closing brackets so a URL
 * at the end of a sentence does not swallow the punctuation — "see https://x.com."
 * links `https://x.com` and leaves the full stop as text.
 */
const URL_RE = /(\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\bmailto:[^\s<>"']+)/gi;
/** Punctuation a sentence may leave hanging off the end of a URL. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

export interface LinkifyProps {
  text: string | null | undefined;
  /** Extra classes for each rendered anchor. */
  linkClassName?: string;
}

export function Linkify({ text, linkClassName }: LinkifyProps): JSX.Element | null {
  if (!text) return null;

  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        // `split` with a capturing group puts the matches at the odd indices.
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;

        /* Punctuation that belongs to the sentence, not the URL. Rendered after
           the anchor so the link is right and the sentence still reads. */
        const trailing = TRAILING.exec(part)?.[0] ?? '';
        const url = trailing ? part.slice(0, -trailing.length) : part;
        if (!url) return <Fragment key={i}>{part}</Fragment>;

        const href = url.startsWith('www.') ? `https://${url}` : url;
        return (
          <Fragment key={i}>
            <a
              href={href}
              /* A customer's link is somebody else's site. `noreferrer
                 noopener` so the target cannot reach back into this tab, which
                 matters more here than anywhere else in the app: the text came
                 from outside. */
              target="_blank"
              rel="noreferrer noopener nofollow"
              // Stop the click reaching a parent row that would open or select.
              onClick={(e) => e.stopPropagation()}
              className={
                linkClassName ??
                'underline decoration-current/40 underline-offset-2 transition-[text-decoration-color] hover:decoration-current'
              }
            >
              {url}
            </a>
            {trailing}
          </Fragment>
        );
      })}
    </>
  );
}
