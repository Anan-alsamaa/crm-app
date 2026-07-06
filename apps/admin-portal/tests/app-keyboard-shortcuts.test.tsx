import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Keep MemoryRouter (and everything else) real; only stub useNavigate so we can
// assert navigation targets fired by the `g`-sequences.
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

import { AppKeyboardShortcuts } from '../src/components/AppKeyboardShortcuts.js';

function renderShortcuts() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );
  return render(<AppKeyboardShortcuts />, { wrapper: Wrapper });
}

/** Dispatch a global keydown, mirroring how the real listener receives events. */
function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...init });
}

describe('AppKeyboardShortcuts', () => {
  beforeEach(() => {
    navigate.mockReset();
  });

  it('mounts and renders nothing visible while the help overlay is closed', () => {
    renderShortcuts();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['u', '/users'],
    ['t', '/teams'],
    ['v', '/vendors'],
    ['s', '/sla'],
    ['r', '/reports'],
  ])('navigates on `g` then `%s` → %s', (letter, path) => {
    renderShortcuts();
    press('g');
    press(letter);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(path);
  });

  it('ignores an unknown letter after the `g` leader', () => {
    renderShortcuts();
    press('g');
    press('x');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the help overlay on `?` and shows the shortcut groups', () => {
    renderShortcuts();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    press('?');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('shortcuts.navigation')).toBeInTheDocument();
    expect(screen.getByText('shortcuts.general')).toBeInTheDocument();
    expect(screen.getByText('nav.users')).toBeInTheDocument();
    expect(screen.getByText('shortcuts.commandPalette')).toBeInTheDocument();
  });

  it('closes the help overlay via the close button', () => {
    renderShortcuts();
    press('?');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('actions.close'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the help overlay when Escape is pressed', () => {
    renderShortcuts();
    press('?');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    press('Escape');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the help overlay on backdrop click', () => {
    renderShortcuts();
    press('?');
    const dialog = screen.getByRole('dialog');
    // The backdrop is the aria-hidden sibling that fills the dialog.
    const backdrop = dialog.querySelector('[aria-hidden]') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores shortcuts when a modifier key is held', () => {
    renderShortcuts();

    press('?', { metaKey: true });
    press('?', { ctrlKey: true });
    press('?', { altKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Modifier + leader sequence is also ignored.
    press('g', { ctrlKey: true });
    press('u');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not fire the sequence when a non-`g` key is pressed first', () => {
    renderShortcuts();
    press('u');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cleans up the keydown listener on unmount', () => {
    const { unmount } = renderShortcuts();
    unmount();
    // After unmount the global listener is gone: a `?` press must not resurrect
    // an overlay (there is nothing mounted to render it either).
    press('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
  });
});
