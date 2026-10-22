import type { ReactNode } from 'react';
import { cn, Toolbar, ToolbarSpacer } from '@yiji/ui';

/*
 * THE ADMIN PAGE FRAME (Rapport skin, owner 2026-10-22: "work on every page").
 *
 * The Dashboard is the standard every other page is held to, and it only looks
 * finished because three things line up: the title, the content and the
 * filters all start at the SAME gutter and run the SAME width. The first pass
 * left most pages with their own `mx-auto max-w-5xl` column under a
 * full-width title, so the body sat visibly off-centre from its own heading.
 *
 * So the frame is spelled once, here:
 *
 *   - `PageHeader`  the big title, an optional one-line description UNDER it
 *                   (never beside it, squeezing the title), actions on the far
 *                   side. No stat strip - the owner removed it from the
 *                   Dashboard and it does not come back anywhere else.
 *   - `PageTitle`   the same title block for a page whose heading lives INSIDE
 *                   its scroll area (the report tabs).
 *   - `PAGE_BODY`   the scrolling body, on the header's own gutter.
 *   - `FILTER_CARD` the Dashboard's frosted filter card, for every filter bar.
 *
 * Visual only: nothing here owns state, and every page keeps its own logic.
 */

/** The horizontal gutter every admin page shares with its header. */
export const PAGE_GUTTER = 'px-5 sm:px-7';

/** The scrolling body under a PageHeader: full width, on the header's gutter. */
export const PAGE_BODY = cn('min-h-0 flex-1 overflow-auto pb-10 pt-2', PAGE_GUTTER);

/** The Dashboard's frosted filter card - one pattern for every filter bar. */
export const FILTER_CARD =
  'rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06] sm:p-[1.125rem]';

/** A plain content card (lists, panels, settings groups). */
export const SECTION_CARD = 'rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]';

/** A field caption above an input, in a filter card or a form. */
export const FIELD_LABEL = 'text-xs font-medium text-muted-foreground';

function TitleBlock({
  title,
  description,
  titleExtra,
}: {
  title: ReactNode;
  description?: ReactNode;
  titleExtra?: ReactNode;
}) {
  return (
    <div className="min-w-0 max-w-full">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="admin-page-title">{title}</h1>
        {titleExtra}
      </div>
      {description && <p className="admin-page-desc">{description}</p>}
    </div>
  );
}

/**
 * The page header: big title, optional description under it, actions on the
 * far side as pills. Renders the shared Toolbar, so the `data-toolbar` hook and
 * its sticky behaviour are unchanged.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleExtra,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, search, switches - laid out at the end side, wrapping on a phone. */
  actions?: ReactNode;
  /** A small badge that belongs to the title itself (e.g. a status pill). */
  titleExtra?: ReactNode;
  className?: string;
}) {
  return (
    <Toolbar className={className}>
      <TitleBlock title={title} description={description} titleExtra={titleExtra} />
      {actions && (
        <>
          <ToolbarSpacer />
          {/* On a phone the actions take their own row under the title, from
              the start edge - one button or five, they land in the same place. */}
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:max-w-full">
            {actions}
          </div>
        </>
      )}
    </Toolbar>
  );
}

/**
 * The same title block, for a page whose heading scrolls with its content (a
 * report under the report tab strip). Same type, same spacing as PageHeader.
 */
export function PageTitle({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-1 pt-3 sm:pt-4',
        className,
      )}
    >
      <TitleBlock title={title} description={description} />
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:max-w-full">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * A wide report table that stays INSIDE its card (owner, 2026-10-22).
 *
 * The reports used `TableSurface flow`: the card grew to the table's own width
 * and the PAGE scrolled sideways, so a 28-column table ran out past its card
 * and off the screen. `fill` is the other bargain the primitive already offers
 * - the card keeps the page's width, takes the height left below it, and
 * scrolls on both axes itself, with the column names sticky at its top. The
 * pager, the row count and the generated-at line live in the card's own
 * footer (`TableSurface footer`), which `fill` measures, so the gap only has
 * to hold the ColumnScroller pill that sticks to the bottom of the page under
 * the card (it pages this scroller, finding it by `data-table-scroller`).
 */
export const WIDE_TABLE = { fill: true, fillGap: 64 } as const;
