import { useEffect, useRef } from 'react';

/**
 * Register global keyboard shortcuts. Supports single keys (`?`) and simple
 * two-key sequences (`g i`). Bindings are keyed by their printable form:
 *   { '?': openHelp, 'g i': goInbox, 'g t': goTickets }
 *
 * Shortcuts are ignored while the user is typing in an input/textarea/select
 * or contenteditable element, and when a modifier (⌘/Ctrl/Alt) is held — those
 * belong to the command palette and the browser.
 */
export function useKeyboardShortcuts(bindings: Record<string, () => void>, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    let leader: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearLeader = () => {
      leader = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      const lower = key.toLowerCase();

      if (leader) {
        const combo = `${leader} ${lower}`;
        clearLeader();
        const seq = ref.current[combo];
        if (seq) {
          e.preventDefault();
          seq();
          return;
        }
      }

      const single = ref.current[key];
      if (single) {
        e.preventDefault();
        single();
        return;
      }

      if (Object.keys(ref.current).some((b) => b.startsWith(`${lower} `))) {
        leader = lower;
        timer = setTimeout(clearLeader, 1000);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearLeader();
    };
  }, [enabled]);
}
