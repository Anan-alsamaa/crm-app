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
