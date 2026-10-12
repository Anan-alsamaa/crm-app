import type { YijiModifierGroup } from '@yiji/shared-types';

/**
 * A LINE'S ADD-ONS, ONE PER ROW, WITH THEIR PRICES (owner, 2026-10-12).
 *
 * The choices used to run together as one dotted paragraph ("Extra Spicy ·
 * Without Broccoli · Mix Sauce"). The owner wants them as Yiji's own order
 * screen shows them: the group ("Extra", "Vegetables Type") as a heading, each
 * chosen option on its own row, and that option's price beside it.
 *
 * `groups` when the order carries them; otherwise the flat `names` (an order
 * read before the groups were kept, or a cached answer), still one per row.
 */
export function ModifierBreakdown({
  groups,
  names,
  currency,
  money,
}: {
  groups?: YijiModifierGroup[];
  names?: string[];
  currency: string;
  money: (amount: number, currency: string) => string;
}) {
  if (groups?.length) {
    return (
      <div className="mt-1 space-y-1 border-s-2 border-border ps-2 text-2xs">
        {groups.map((g, gi) => (
          <div key={`${g.name}-${gi}`}>
            {g.name && <div className="font-medium text-muted-foreground">{g.name}</div>}
            <ul>
              {g.options.map((o, oi) => (
                <li
                  key={`${o.name}-${oi}`}
                  className="flex items-baseline justify-between gap-2 text-foreground/80"
                >
                  <span className="min-w-0">
                    {o.qty > 1 && <span className="tabular-nums">{o.qty}× </span>}
                    {o.name}
                  </span>
                  <span
                    className={
                      o.price > 0
                        ? 'shrink-0 tabular-nums text-foreground/80'
                        : 'shrink-0 tabular-nums text-muted-foreground'
                    }
                  >
                    {/* Every option shows its price, 0 included - as Yiji's
                        own screen does. A paid one is marked with a plus. */}
                    {o.price > 0 ? `+${money(o.price * o.qty, currency)}` : money(0, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  if (!names?.length) return null;
  return (
    <ul className="mt-1 border-s-2 border-border ps-2 text-2xs text-foreground/80">
      {names.map((n, i) => (
        <li key={`${n}-${i}`}>{n}</li>
      ))}
    </ul>
  );
}
