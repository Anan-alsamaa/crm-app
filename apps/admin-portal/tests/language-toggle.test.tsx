import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const changeLanguage = vi.hoisted(() => vi.fn());
const i18nState = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: i18nState.language, changeLanguage } }),
}));

import { LanguageToggle } from '../src/components/LanguageToggle.js';

beforeEach(() => {
  changeLanguage.mockReset();
  i18nState.language = 'en';
});

describe('LanguageToggle', () => {
  it('shows Arabic label when current language is English', () => {
    render(<LanguageToggle />);
    expect(screen.getByText('العربية')).toBeInTheDocument();
  });

  it('switches to Arabic on click from English', async () => {
    render(<LanguageToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(changeLanguage).toHaveBeenCalledWith('ar');
  });

  it('shows EN label and switches to English when current is Arabic', async () => {
    i18nState.language = 'ar';
    render(<LanguageToggle />);
    expect(screen.getByText('EN')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(changeLanguage).toHaveBeenCalledWith('en');
  });
});
