import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    // The form formats the order date, so it reads i18n.language. Omitting it
    // made the whole component throw rather than the assertion fail, which is
    // the kind of mock gap that reads as a product bug.
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

const hooks = vi.hoisted(() => ({
  useCreateTicketFromConversation: vi.fn(),
  useConversationAttachmentIds: vi.fn(),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);

import { CreateTicketDialog } from '../src/features/tickets/CreateTicketDialog.js';

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    onClose,
    ...render(<CreateTicketDialog contactId="k1" vendorId="v1" onClose={onClose} />, {
      wrapper: Wrapper,
    }),
  };
}

beforeEach(() => {
  hooks.useCreateTicketFromConversation.mockReset();
  hooks.useCreateTicketFromConversation.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
  });
  hooks.useConversationAttachmentIds.mockReset();
  hooks.useConversationAttachmentIds.mockReturnValue({ data: [] });
});

describe('CreateTicketForm', () => {
  it('renders as a page with its fields, not a modal', () => {
    renderDialog();
    // Every entry point is a route now. Announcing it as a dialog would tell a
    // screen reader the rest of the app is inert when it is simply gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('tickets.subject')).toBeInTheDocument();
    expect(screen.getByText('tickets.description')).toBeInTheDocument();
  });

  it('closes when Cancel is clicked', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByText('actions.cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('submits a valid form and creates a ticket', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync });
    const { onClose } = renderDialog();
    const subject = screen.getByText('tickets.subject').parentElement!.querySelector('input')!;
    await userEvent.type(subject, 'Refund request');
    await userEvent.click(screen.getByText('tickets.create'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: expect.objectContaining({
            subject: 'Refund request',
            contact: 'k1',
            vendor: 'v1',
            assigned_agent: 'agent-1',
          }),
          attachmentFileIds: [],
        }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
