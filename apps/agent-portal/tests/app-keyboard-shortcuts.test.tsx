import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Capture navigations driven by the wired shortcuts.
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

/** Fire a leader+key `g`-sequence on window. */
function pressSequence(leader: string, key: string) {
  fireEvent.keyDown(window, { key: leader });
  fireEvent.keyDown(window, { key });
}

describe('AppKeyboardShortcuts', () => {
  beforeEach(() => navigate.mockReset());

  it('renders nothing visible until the help overlay is opened', () => {
    renderShortcuts();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigates to the inbox on `g i`', () => {
    renderShortcuts();
    pressSequence('g', 'i');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('navigates to tickets on `g t`', () => {
    renderShortcuts();
    pressSequence('g', 't');
    expect(navigate).toHaveBeenCalledWith('/tickets');
  });

  it('navigates to contacts on `g c`', () => {
    renderShortcuts();
    pressSequence('g', 'c');
    expect(navigate).toHaveBeenCalledWith('/contacts');
  });

  it('navigates to preferences on `g p`', () => {
    renderShortcuts();
    pressSequence('g', 'p');
    expect(navigate).toHaveBeenCalledWith('/preferences');
  });

  it('opens the shortcuts overlay on `?` and lists the shortcut groups', () => {
    renderShortcuts();
    fireEvent.keyDown(window, { key: '?' });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Group headings and rows are rendered from the memoized groups.
    expect(screen.getByText('shortcuts.navigation')).toBeInTheDocument();
    expect(screen.getByText('shortcuts.general')).toBeInTheDocument();
    expect(screen.getByText('nav.inbox')).toBeInTheDocument();
    expect(screen.getByText('shortcuts.commandPalette')).toBeInTheDocument();
  });

  it('closes the overlay on its close button', () => {
    renderShortcuts();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // closeLabel comes from t('actions.close', { ns: 'common' }) -> the key.
    fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the overlay on Escape', () => {
    renderShortcuts();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores shortcuts when a modifier key is held', () => {
    renderShortcuts();
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});
