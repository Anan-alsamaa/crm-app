import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'admin-1' } }),
}));

const aiAdmin = vi.hoisted(() => ({
  getConfig: vi.fn(),
  putConfig: vi.fn(),
  getUsage: vi.fn(),
}));
vi.mock('../src/lib/ai-client.js', () => ({ aiAdmin }));

import { AiConfigPage } from '../src/features/ai-config/AiConfigPage.js';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AiConfigPage />, { wrapper: Wrapper });
}

const baseConfig = {
  summarize: true,
  suggestReply: false,
  analyzeSentiment: true,
  detectIntent: false,
  extractEntities: false,
  semanticSearch: false,
  scoreLead: false,
  helpAssistant: false,
  monthlyCap: 1000,
  helpDailyPerUser: 20,
};

beforeEach(() => {
  aiAdmin.getConfig.mockReset();
  aiAdmin.putConfig.mockReset();
  aiAdmin.getUsage.mockReset();
  aiAdmin.getUsage.mockResolvedValue({ used: 12, cap: 1000 });
});

describe('AiConfigPage', () => {
  it('renders the title and feature toggles after loading', async () => {
    aiAdmin.getConfig.mockResolvedValue(baseConfig);
    renderPage();
    expect(screen.getByRole('heading', { name: 'AI assistance', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Summarize conversation')).toBeInTheDocument());
    expect(screen.getAllByRole('switch').length).toBe(8);
  });

  it('renders the help-assistant toggle and its daily allowance field', async () => {
    aiAdmin.getConfig.mockResolvedValue(baseConfig);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Help assistant' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('switch', { name: 'Help assistant' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByLabelText('Daily questions per user')).toHaveValue(20);
  });

  it('saves the help-assistant toggle and daily allowance', async () => {
    aiAdmin.getConfig.mockResolvedValue(baseConfig);
    aiAdmin.putConfig.mockResolvedValue({
      ...baseConfig,
      helpAssistant: true,
      helpDailyPerUser: 5,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Help assistant' })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Help assistant' }));
    const allowance = screen.getByLabelText('Daily questions per user');
    await userEvent.clear(allowance);
    await userEvent.type(allowance, '5');
    await userEvent.click(screen.getByText('actions.save'));
    await waitFor(() =>
      expect(aiAdmin.putConfig).toHaveBeenCalledWith(
        { userId: 'admin-1' },
        expect.objectContaining({ helpAssistant: true, helpDailyPerUser: 5 }),
      ),
    );
  });

  it('shows current usage', async () => {
    aiAdmin.getConfig.mockResolvedValue(baseConfig);
    renderPage();
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
  });

  it('enables save and persists after toggling a feature', async () => {
    aiAdmin.getConfig.mockResolvedValue(baseConfig);
    aiAdmin.putConfig.mockResolvedValue({ ...baseConfig, suggestReply: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('Suggest reply')).toBeInTheDocument());
    const toggle = screen.getByRole('switch', { name: 'Suggest reply' });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByText('actions.save'));
    await waitFor(() => expect(aiAdmin.putConfig).toHaveBeenCalled());
  });
});
