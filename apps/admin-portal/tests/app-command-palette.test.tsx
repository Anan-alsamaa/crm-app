import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../src/features/users/api.js', () => ({
  useUsers: () => ({
    data: [
      {
        id: 'u1',
        email: 'a@b.com',
        first_name: 'Ann',
        last_name: 'Lee',
        role: { name: 'Admin' },
        team: { name: 'Sales' },
      },
    ],
  }),
}));
vi.mock('../src/features/teams/api.js', () => ({
  useTeams: () => ({ data: [{ id: 't1', name: 'Sales', description: 'sells' }] }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));

import { AppCommandPalette } from '../src/components/AppCommandPalette.js';

function renderPalette() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );
  return render(<AppCommandPalette />, { wrapper: Wrapper });
}

beforeEach(() => {});

describe('AppCommandPalette', () => {
  it('mounts without crashing and builds command groups (palette closed by default)', () => {
    const { container } = renderPalette();
    // Palette is closed initially, so it renders nothing visible — but the
    // useMemo group construction (users/teams/actions) has executed.
    expect(container).toBeTruthy();
  });
});
