import type { JSX } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, Input } from '@yiji/ui';

/**
 * Pick any number of branches out of a list too long to look at.
 *
 * There are 122 branches. They used to be rendered as 122 chips in a scrolling
 * box, which is the state the code's own comment warned about — "offering all
 * 122 under a brand with two is how a picker stops helping". Finding one meant
 * reading the whole list, and the ones already ticked were scattered through
 * it, so the answer to "what is this role fenced to" required scrolling.
 *
 * So the two questions get two places. WHAT IS CHOSEN is always on screen as
 * removable chips, however long the list behind it. WHAT COULD BE CHOSEN is
 * behind a search, because past a couple of dozen options a list is not a
 * choice, it is a haystack.
 *
 * The list is always there to browse. It used to render nothing until you
 * typed, on the theory that dumping 122 options is a haystack — but that made
 * choosing REQUIRE guessing a name, and somebody fencing a role to "all of one
 * brand" had to already know every branch it has. Search narrows the list now;
 * it does not conjure it.
 *
 * What makes browsing workable is the label: every option reads
 * "{brand} - {branch}" and the list is sorted, so it falls into brand blocks
 * and scanning to a brand is a flick rather than a read.
 */

export interface BranchOption {
  id: string;
  /** Already disambiguated by the caller when two brands share a mall name. */
  label: string;
}

interface Props {
  options: readonly BranchOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  className?: string;
}

/**
 * How many rows to render at once.
 *
 * Generous, because the box scrolls and the point is to browse. The cap exists
 * so a 500-branch estate cannot make the roles editor janky, not to ration
 * what is shown.
 */
const MAX_RESULTS = 200;

export function BranchPicker({ options, selected, onChange, className }: Props): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const chosen = useMemo(
    // Filtered through the map rather than trusted: narrowing the brand fence
    // can leave a branch selected that is no longer on offer, and rendering a
    // chip with no label for it would be a mystery rather than a fact.
    () => selected.map((id) => byId.get(id)).filter((o): o is BranchOption => !!o),
    [selected, byId],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // No query means EVERY option, not none of them.
    if (!q) return options.slice(0, MAX_RESULTS + 1);
    return options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, MAX_RESULTS + 1);
  }, [options, query]);

  /** Every option currently listed, so "select all of this brand" is one click. */
  const allShownSelected = shownAllSelected(matches, selected);

  const shown = matches.slice(0, MAX_RESULTS);
  const overflow = matches.length > MAX_RESULTS;

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  /**
   * Tick or untick everything the search currently shows.
   *
   * The reason this is worth a button: "fence this role to Casa Pasta" is the
   * common request, and with brand-first labels typing the brand leaves
   * exactly its branches on screen. One click then beats fourteen.
   */
  const toggleAllShown = (): void => {
    const ids = matches.slice(0, MAX_RESULTS).map((o) => o.id);
    onChange(
      allShownSelected
        ? selected.filter((id) => !ids.includes(id))
        : [...new Set([...selected, ...ids])],
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── What is chosen ─────────────────────────────────────────────────
          Always visible, and the only place the answer lives. */}
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chosen.map((o) => (
            <span
              key={o.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-tint px-3 py-1.5 text-xs font-medium text-sky ring-1 ring-inset ring-sky/30"
            >
              {o.label}
              <button
                type="button"
                onClick={() => toggle(o.id)}
                aria-label={t('roles.branchRemove', {
                  defaultValue: 'Remove {{name}}',
                  name: o.label,
                })}
                className="grid h-4 w-4 place-items-center rounded-full text-sky/70 transition-colors hover:bg-sky/20 hover:text-sky"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-2.5 w-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange([])}
            className="ms-1 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-destructive"
          >
            {t('roles.branchClear', { defaultValue: 'Clear all' })}
          </button>
        </div>
      )}

      {/* ── What could be chosen ───────────────────────────────────────────*/}
      <Input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the top match, so adding several in a row never needs
          // the mouse: type, Enter, type, Enter.
          if (e.key === 'Enter' && shown[0]) {
            e.preventDefault();
            toggle(shown[0].id);
            setQuery('');
          }
        }}
        aria-label={t('roles.branchSearch', { defaultValue: 'Search branches' })}
        placeholder={t('roles.branchSearchPlaceholder', {
          defaultValue: 'Search {{n}} branches…',
          n: options.length,
        })}
        className="h-9"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-muted-foreground">
          {selected.length === 0
            ? t('roles.branchNoneMeansAll', {
                defaultValue: 'Nothing selected — the role sees every branch its brands allow.',
              })
            : t('roles.branchCount', {
                defaultValue: '{{n}} selected.',
                n: selected.length,
              })}
        </p>
        {shown.length > 0 && (
          <button
            type="button"
            onClick={toggleAllShown}
            className="text-2xs font-semibold uppercase tracking-[0.1em] text-primary transition-colors hover:underline"
          >
            {allShownSelected
              ? t('roles.branchDeselectShown', {
                  defaultValue: 'Clear these {{n}}',
                  n: shown.length,
                })
              : t('roles.branchSelectShown', {
                  defaultValue: 'Select these {{n}}',
                  n: shown.length,
                })}
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t('roles.branchNoMatch', {
            defaultValue: 'No branch matches “{{q}}”.',
            q: query.trim(),
          })}
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto rounded-xl ring-1 ring-inset ring-foreground/[0.08]">
          <ul>
            {shown.map((o) => {
              const on = selected.includes(o.id);
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => toggle(o.id)}
                    // A results row is a toggle, not a link: pressing an
                    // already-chosen one removes it, which is what somebody
                    // who searched for it again is usually trying to do.
                    aria-pressed={on}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm transition-colors duration-fast',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                      on ? 'bg-sky-tint/60 text-foreground' : 'hover:bg-secondary',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        // `rounded-[5px]`, NOT `rounded`. In this design system
                        // `rounded` is calc(var(--radius) - 2px) = 18px, which
                        // on a 16px box is a circle — and a circle reads as
                        // "pick one" next to a control whose whole point is
                        // picking several.
                        'grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors',
                        on ? 'border-sky bg-sky text-white' : 'border-foreground/25',
                      )}
                    >
                      {on && (
                        <svg
                          viewBox="0 0 16 16"
                          className="h-2.5 w-2.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 8.5l3.5 3.5L13 5" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 truncate">{o.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {overflow && (
            <p className="border-t border-foreground/[0.08] px-3 py-2 text-2xs text-muted-foreground">
              {/* Said out loud rather than silently truncating: a picker that
                  hides matches without admitting it is how somebody concludes
                  a branch does not exist. */}
              {t('roles.branchMore', {
                defaultValue: 'More matches — keep typing to narrow.',
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** True when every option on screen is already selected. */
function shownAllSelected(matches: readonly BranchOption[], selected: readonly string[]): boolean {
  const shown = matches.slice(0, MAX_RESULTS);
  return shown.length > 0 && shown.every((o) => selected.includes(o.id));
}
