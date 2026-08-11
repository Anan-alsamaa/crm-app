import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppShell } from '@yiji/ui';

/** Stub window.matchMedia so useIsDesktop can resolve deterministically. */
function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  // @ts-expect-error remove the stub between tests
  delete window.matchMedia;
});

function renderShell() {
  return render(
    <AppShell
      rail={(ctx) => <span>rail:{ctx.variant}</span>}
      topBarBrand={<span>Brand</span>}
      resizeStorageKey="test.sidebarWidth"
      navLabel="Primary navigation"
      menuLabel="Open menu"
      closeLabel="Close menu"
    >
      <div>page content</div>
    </AppShell>,
  );
}

describe('AppShell', () => {
  it('desktop: renders the side rail + main, no hamburger', () => {
    mockMatchMedia(true);
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.getByText('rail:desktop')).toBeInTheDocument();
    expect(screen.queryByLabelText('Open menu')).toBeNull();
  });

  it('mobile: shows a hamburger that toggles the drawer; rail renders in mobile variant', () => {
    mockMatchMedia(false);
    renderShell();
    const menu = screen.getByLabelText('Open menu');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('page content')).toBeInTheDocument();
    // The drawer is always mounted (hidden until open), so the rail is present.
    expect(screen.getByText('rail:mobile')).toBeInTheDocument();

    fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
  });
});

/** The top-nav layout: `navBar` replaces the desktop side rail with two bars. */
function renderTopNavShell() {
  return render(
    <AppShell
      rail={(ctx) => <span>rail:{ctx.variant}</span>}
      topBar={<span>utility bar</span>}
      navBar={<span>nav band</span>}
      topBarBrand={<span>Brand</span>}
      resizeStorageKey="test.sidebarWidth"
      navLabel="Primary navigation"
      menuLabel="Open menu"
      closeLabel="Close menu"
    >
      <div>page content</div>
    </AppShell>,
  );
}

describe('AppShell with navBar (top-nav layout)', () => {
  it('desktop: renders both bars and drops the side rail entirely', () => {
    mockMatchMedia(true);
    renderTopNavShell();
    expect(screen.getByText('utility bar')).toBeInTheDocument();
    expect(screen.getByText('nav band')).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
    // The whole point of the layout: no vertical rail on desktop.
    expect(screen.queryByText('rail:desktop')).toBeNull();
    // The nav landmark is now the horizontal band.
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(nav).toContainElement(screen.getByText('nav band'));
  });

  it('mobile: falls back to the drawer, so the rail still backs small screens', () => {
    mockMatchMedia(false);
    renderTopNavShell();
    // Below lg a horizontal bar cannot fit, so the vertical nav must survive.
    expect(screen.getByText('rail:mobile')).toBeInTheDocument();
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
    expect(screen.queryByText('nav band')).toBeNull();
  });

  it('without navBar the desktop rail is unaffected (admin portal path)', () => {
    mockMatchMedia(true);
    renderShell();
    expect(screen.getByText('rail:desktop')).toBeInTheDocument();
  });
});
