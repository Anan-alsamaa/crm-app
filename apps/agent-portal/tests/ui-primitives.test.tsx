import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { ErrorBoundary, SelectMenu, useIsDesktop, useKeyboardShortcuts } from '@yiji/ui';

afterEach(() => cleanup());

// ---- useKeyboardShortcuts ----------------------------------------------------

function KeysHarness({ bindings }: { bindings: Record<string, () => void> }) {
  useKeyboardShortcuts(bindings);
  return <input data-testid="field" />;
}

describe('useKeyboardShortcuts', () => {
  it('fires a single-key binding', () => {
    const help = vi.fn();
    render(<KeysHarness bindings={{ '?': help }} />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(help).toHaveBeenCalledTimes(1);
  });

  it('fires a two-key sequence (g i)', () => {
    const goInbox = vi.fn();
    render(<KeysHarness bindings={{ 'g i': goInbox }} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'i' });
    expect(goInbox).toHaveBeenCalledTimes(1);
  });

  it('ignores shortcuts while typing in an input', () => {
    const help = vi.fn();
    render(<KeysHarness bindings={{ '?': help }} />);
    fireEvent.keyDown(screen.getByTestId('field'), { key: '?' });
    expect(help).not.toHaveBeenCalled();
  });

  it('ignores keys held with a modifier (those belong to the palette/browser)', () => {
    const help = vi.fn();
    render(<KeysHarness bindings={{ k: help }} />);
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(help).not.toHaveBeenCalled();
  });
});

// ---- ErrorBoundary -----------------------------------------------------------

let boomState = { throw: true };
function Boom() {
  if (boomState.throw) throw new Error('boom');
  return <div>recovered</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    boomState = { throw: true };
    // React logs caught render errors to console.error; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the fallback when a child throws, and recovers on reset', () => {
    render(
      <ErrorBoundary fallback={({ reset }) => <button onClick={reset}>retry</button>}>
        <Boom />
      </ErrorBoundary>,
    );
    const retry = screen.getByText('retry');
    expect(retry).toBeInTheDocument();

    boomState.throw = false; // child will succeed on the next render
    fireEvent.click(retry);
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('auto-recovers when resetKeys change', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/a']} fallback={() => <span>fallback</span>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('fallback')).toBeInTheDocument();

    boomState.throw = false;
    rerender(
      <ErrorBoundary resetKeys={['/b']} fallback={() => <span>fallback</span>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});

// ---- useMediaQuery / useIsDesktop -------------------------------------------

function MqHarness({ onValue }: { onValue: (v: boolean) => void }) {
  const isDesktop = useIsDesktop();
  useEffect(() => onValue(isDesktop), [isDesktop, onValue]);
  return <div>{isDesktop ? 'desktop' : 'mobile'}</div>;
}

describe('useIsDesktop', () => {
  afterEach(() => {
    // @ts-expect-error allow cleanup of the stub
    delete window.matchMedia;
  });

  it('reflects a matching media query', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    render(<MqHarness onValue={() => {}} />);
    expect(screen.getByText('desktop')).toBeInTheDocument();
  });

  it('falls back to false when matchMedia is unavailable', () => {
    // matchMedia is not defined in jsdom by default (deleted in afterEach).
    render(<MqHarness onValue={() => {}} />);
    expect(screen.getByText('mobile')).toBeInTheDocument();
  });
});

// ---- SelectMenu -------------------------------------------------------------

function MenuHarness({
  initial = 'open',
  onPick,
}: {
  initial?: string;
  onPick?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SelectMenu
      aria-label="Status"
      value={value}
      onChange={(v) => {
        setValue(v);
        onPick?.(v);
      }}
      options={[
        { value: 'open', label: 'Open' },
        { value: 'pending', label: 'Pending' },
        { value: 'resolved', label: 'Resolved' },
      ]}
    />
  );
}

describe('SelectMenu', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView; the open menu scrolls the active
    // option into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the selected option in the trigger and no listbox while closed', () => {
    render(<MenuHarness initial="pending" />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Pending');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on click and selects an option with the mouse', () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Status' });

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Resolved' })).toBeInTheDocument();

    // The click target is the inner button (the row), not the li[role=option].
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(onPick).toHaveBeenCalledWith('resolved');
    // Menu closes and the trigger reflects the new value.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Resolved');
  });

  it('navigates and selects with the keyboard (ArrowDown + Enter)', () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Status' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // opens, active = selected (open)
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // active -> pending
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('pending');
  });

  it('jumps to a match via type-ahead', () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Status' });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'r' }); // -> Resolved
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('resolved');
  });

  it('closes on Escape without selecting', () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Status' });

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });
});
