import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { CAMPAIGN_FIELD_SPEC } from '@yiji/shared-types';
import i18n from '../src/i18n/index.js';
import { SampleMarketingEngine, resetSampleEngine } from '../src/engine/sample.js';

/* THE FORM ITSELF (owner, 2026-11-17): every step renders, in English and
   in Arabic, and shows the design's fields for the goal chosen. */

const engine = new SampleMarketingEngine(() => 'maha');
vi.mock('../src/engine/index.js', () => ({
  useEngine: () => engine,
  useEngineChoice: () => ({ choice: 'sample', known: true }),
}));

const { CampaignWizardPage } = await import('../src/features/promo/CampaignWizard.js');

function mount(path = '/coupons/new?objective=OCCASION') {
  resetSampleEngine();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <CampaignWizardPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

/** The step buttons in the left-hand list. */
const stepButtons = (c: HTMLElement) => [...c.querySelectorAll('ol button')] as HTMLElement[];

describe('the campaign form renders every step', () => {
  it.each(['en', 'ar'])('in %s, with the design labels of each step', async (lng) => {
    await i18n.changeLanguage(lng);
    const { container } = mount();
    await waitFor(() => expect(stepButtons(container)).toHaveLength(7));
    const seen = new Set<string>();
    for (let s = 1; s <= 7; s++) {
      fireEvent.click(stepButtons(container)[s - 1]!);
      const text = container.textContent ?? '';
      for (const f of CAMPAIGN_FIELD_SPEC.filter((x) => x.step === s)) {
        const label = i18n.t(`promo.field.${f.key}`, { defaultValue: f.label });
        if (text.includes(label)) seen.add(f.path);
      }
    }
    /* An OCCASION goal shows its birthday fields; the conditional ones for
       other goals and offer types are not on screen, but every always-shown
       field is. */
    for (const f of CAMPAIGN_FIELD_SPEC.filter((x) => !x.when && x.required !== 'conditional'))
      expect(seen.has(f.path), f.path).toBe(true);
    expect(seen.has('trigger.birthday.occasion')).toBe(true);
  });

  it('shows the conditional fields once their condition is chosen', async () => {
    await i18n.changeLanguage('en');
    const { container } = mount('/coupons/new?objective=FREQUENT_ORDER');
    await waitFor(() => expect(stepButtons(container)).toHaveLength(7));
    fireEvent.click(stepButtons(container)[1]!);
    expect(screen.getByText(/How customers earn the reward/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Challenge' }));
    expect(screen.getByText(/^Within/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Milestone' }));
    expect(screen.getByText(/Reward on lifetime order number/)).toBeInTheDocument();
    fireEvent.click(stepButtons(container)[4]!);
    fireEvent.click(screen.getByLabelText('Valid all day'));
    expect(screen.getByText('Start time')).toBeInTheDocument();
    fireEvent.click(stepButtons(container)[5]!);
    fireEvent.click(screen.getByRole('button', { name: 'sms' }));
    expect(screen.getByText(/SMS text \(Arabic\)/)).toBeInTheDocument();
  });
});
