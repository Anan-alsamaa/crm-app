import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonthBars } from '../src/features/dashboard/ComplaintDashboard.js';

/*
 * The Operations trend.
 *
 * Every other panel on that board is a RANKING — which branch, which brand,
 * which area manager is worst right now. None of them answers whether last
 * month's visit worked, which is the question this exists for.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? '',
    i18n: { language: 'en' },
  }),
}));

describe('MonthBars', () => {
  const months = [
    { month: '2026-06', count: 40 },
    { month: '2026-07', count: 50 },
    { month: '2026-08', count: 12 },
  ];

  it('draws one bar per month, labelled and counted', () => {
    render(<MonthBars months={months} />);
    for (const m of months) expect(screen.getByText(String(m.count))).toBeInTheDocument();
    expect(screen.getByText('Jun')).toBeInTheDocument();
    expect(screen.getByText('Aug')).toBeInTheDocument();
  });

  it('scales every bar against the TALLEST month, not an absolute', () => {
    /*
     * The shape is a comparison between the months shown. July is the peak, so
     * it is 100%; August at 12 of 50 is 24%. Scaling against some fixed number
     * nobody has would make a quiet month look like a crisis.
     */
    const { container } = render(<MonthBars months={months} />);
    const heights = Array.from(container.querySelectorAll<HTMLElement>('[title]')).map(
      (el) => el.style.height,
    );
    expect(heights).toEqual(['80%', '100%', '24%']);
  });

  it('keeps a one-ticket month VISIBLE rather than a sliver of nothing', () => {
    // 1 of 500 is 0.2% — a bar too short to see, and "invisible" and "zero" are
    // different answers.
    const { container } = render(
      <MonthBars
        months={[
          { month: '2026-07', count: 500 },
          { month: '2026-08', count: 1 },
        ]}
      />,
    );
    const bars = Array.from(container.querySelectorAll<HTMLElement>('[title]'));
    expect(bars[1]?.style.minHeight).toBe('4px');
  });

  it('shows at most twelve months, keeping the most RECENT', () => {
    // Beyond a year the bars are too thin to compare, and the older half is not
    // what anyone is acting on.
    const many = Array.from({ length: 18 }, (_, i) => ({
      month: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
      count: i + 1,
    }));
    const { container } = render(<MonthBars months={many} />);
    expect(container.querySelectorAll('[title]').length).toBe(12);
    // The last month given must survive the trim.
    expect(screen.getByText('18')).toBeInTheDocument();
  });
});
