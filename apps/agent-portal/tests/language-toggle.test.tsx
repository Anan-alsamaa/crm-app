import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// A mutable i18n stub so the toggle reads/writes language deterministically.
const i18n = vi.hoisted(() => ({ language: 'en', changeLanguage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n,
  }),
}));

import { LanguageToggle } from '../src/components/LanguageToggle.js';

beforeEach(() => {
  i18n.language = 'en';
  i18n.changeLanguage.mockReset();
});

describe('LanguageToggle', () => {
  it('offers Arabic when the current language is English', () => {
    render(<LanguageToggle />);
    expect(screen.getByText('العربية')).toBeInTheDocument();
  });

  it('offers EN when the current language is Arabic', () => {
    i18n.language = 'ar';
    render(<LanguageToggle />);
    expect(screen.getByText('EN')).toBeInTheDocument();
  });

  it('switches language on click', async () => {
    render(<LanguageToggle />);
    await userEvent.click(screen.getByLabelText('Toggle language'));
    expect(i18n.changeLanguage).toHaveBeenCalledWith('ar');
  });
});
