import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef, useState, type ReactNode } from 'react';

/**
 * COMPOSER PANELS CLOSE ON A PRESS OUTSIDE THEM, OR ESCAPE (owner, 2026-10-25).
 *
 * AI assistance, the Enhance suggestion and quick replies all share one hook:
 * a press outside the panel AND its trigger closes it; the trigger still
 * toggles; a press into the composer counts as outside but loses nothing; a
 * quick reply picked from the list still lands, then the list closes.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string) => ({ collection }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async () => [
      { id: 'r1', label: 'Greeting', text: 'Hello {name}', lang: 'en', kind: 'chat' },
    ]),
  },
}));

import { useDismissOnOutside } from '../src/lib/useDismissOnOutside.js';
import { QuickReplies } from '../src/features/conversation/QuickReplies.js';

function Panel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('half a reply');
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissOnOutside(open, () => setOpen(false), [panel, trigger]);
  return (
    <div>
      <button ref={trigger} type="button" onClick={() => setOpen((v) => !v)}>
        AI
      </button>
      {open && (
        <div ref={panel} data-testid="panel">
          <button type="button">inside</button>
        </div>
      )}
      <textarea aria-label="composer" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <p>elsewhere</p>
    </div>
  );
}

/* A real press: pointerdown, then the click where it lands. */
function press(el: Element) {
  fireEvent.pointerDown(el);
  fireEvent.click(el);
}

describe('useDismissOnOutside', () => {
  it('closes on a press outside, keeps open on a press inside', () => {
    render(<Panel />);
    press(screen.getByText('AI'));
    press(screen.getByText('inside'));
    expect(screen.getByTestId('panel')).toBeTruthy();
    press(screen.getByText('elsewhere'));
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('lets the trigger toggle it shut instead of close-then-reopen', () => {
    render(<Panel />);
    press(screen.getByText('AI'));
    expect(screen.getByTestId('panel')).toBeTruthy();
    press(screen.getByText('AI'));
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('a press into the composer closes it and keeps the draft', () => {
    render(<Panel />);
    press(screen.getByText('AI'));
    const box = screen.getByLabelText('composer') as HTMLTextAreaElement;
    press(box);
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(box.value).toBe('half a reply');
  });

  it('Escape closes it', () => {
    render(<Panel />);
    press(screen.getByText('AI'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('panel')).toBeNull();
  });
});

function Composer({ onPick, query = '' }: { onPick: (t: string) => void; query?: string }) {
  const qc = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))[0];
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return wrap(
    <div>
      <QuickReplies
        inToolbar
        customerText=""
        query={query}
        searching={query.startsWith('/') || !!query}
        vars={{ name: 'Sara' }}
        onPick={onPick}
        dismissSearchOnOutside
        searchOwner="[data-composer]"
      />
      <div data-composer="">
        <textarea aria-label="composer" defaultValue="" />
      </div>
      <p>thread</p>
    </div>,
  );
}

describe('quick replies dismiss', () => {
  const trigger = async () => screen.findByRole('button', { name: /Quick replies|quickReplies/i });

  it('a press outside closes the list; picking a reply inserts it then closes', async () => {
    const onPick = vi.fn();
    render(<Composer onPick={onPick} />);
    press(await trigger());
    expect(screen.getByRole('listbox')).toBeTruthy();
    press(screen.getByText('thread'));
    expect(screen.queryByRole('listbox')).toBeNull();

    press(await trigger());
    press(screen.getByRole('option'));
    expect(onPick).toHaveBeenCalledWith('Hello Sara', 'r1');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a press into the composer closes a list opened from the button', async () => {
    render(<Composer onPick={() => {}} />);
    press(await trigger());
    press(screen.getByLabelText('composer'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a "/" search stays open while typing in the composer, closes elsewhere or on Escape', async () => {
    render(<Composer onPick={() => {}} query="gr" />);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    press(screen.getByLabelText('composer'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    press(screen.getByText('thread'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape puts a "/" search away', async () => {
    render(<Composer onPick={() => {}} query="gr" />);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

/*
 * The AI panel and the Enhance card are wired through the same hook. Asserted
 * against the source: both need a QueryClient, auth and a live AI gateway to
 * mount, and the behaviour itself is the hook's, tested above.
 */
describe('AI panel and Enhance use the shared hook', () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
  it('AI assistance: panel and its button are the inside', () => {
    const view = read('../src/features/conversation/ConversationView.tsx');
    expect(view).toContain(
      'useDismissOnOutside(aiOpen, () => setAiOpen(false), [aiPanelRef, aiButtonRef])',
    );
    expect(view).toContain('ref={aiButtonRef}');
    expect(view).toContain('<div ref={aiPanelRef}>');
    expect(view).toContain('searchOwner="[data-composer]"');
  });
  it('Enhance: the card and the button share one wrapper', () => {
    const src = read('../src/features/conversation/EnhanceButton.tsx');
    expect(src).toContain('useDismissOnOutside(!!suggestion, () => setSuggestion(null), [wrap])');
    expect(src).toContain("<div ref={wrap} className={cn('relative', className)}>");
  });
});
