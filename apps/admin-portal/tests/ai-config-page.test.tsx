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
  monthlyCap: 1000,
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
    expect(screen.getByText('AI assistance')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Summarize conversation')).toBeInTheDocument());
    expect(screen.getAllByRole('switch').length).toBe(7);
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
