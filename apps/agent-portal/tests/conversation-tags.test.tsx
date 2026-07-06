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

// Keep the real UI primitives (ConfirmDialog, CloseIcon, cn) but override
// `toast` so error/success paths can be asserted on.
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@yiji/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@yiji/ui')>()),
  toast,
}));

const emit = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/socket.js', () => ({
  getSocket: vi.fn().mockResolvedValue({ emit, on: vi.fn() }),
}));

const inbox = vi.hoisted(() => ({
  useTags: vi.fn(),
  useAddTagToConversation: vi.fn(),
  useRemoveTagFromConversation: vi.fn(),
  useCreateTag: vi.fn(),
  useDeleteTag: vi.fn(),
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

import { ConversationTags } from '../src/features/conversation/ConversationTags.js';

// Mutation stubs, refreshed per test so calls can be asserted.
let addMutate: ReturnType<typeof vi.fn>;
let removeMutate: ReturnType<typeof vi.fn>;
let createMutate: ReturnType<typeof vi.fn>;
let deleteMutate: ReturnType<typeof vi.fn>;

const LIBRARY = [
  { id: 'tg1', name: 'VIP', color: '#ff0000' },
  { id: 'tg2', name: 'Refund', color: null },
];

function makeConversation(tags: unknown[] = []) {
  return { id: 'c1', tags } as never;
}

function assignedTag(junctionId: string, tag: { id: string; name: string; color: string | null }) {
  return { id: junctionId, tags_id: tag };
}

function renderTags(conversation = makeConversation()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ConversationTags conversation={conversation} />, { wrapper: Wrapper });
}

beforeEach(() => {
  toast.error.mockReset();
  toast.success.mockReset();
  emit.mockReset();

  addMutate = vi.fn().mockResolvedValue({});
  removeMutate = vi.fn().mockResolvedValue({});
  createMutate = vi.fn().mockResolvedValue({ id: 'new1', name: 'Fresh', color: null });
  deleteMutate = vi.fn().mockResolvedValue({});

  inbox.useTags.mockReturnValue({ data: LIBRARY });
  inbox.useAddTagToConversation.mockReturnValue({ mutateAsync: addMutate });
  inbox.useRemoveTagFromConversation.mockReturnValue({ mutateAsync: removeMutate });
  inbox.useCreateTag.mockReturnValue({ mutateAsync: createMutate });
  inbox.useDeleteTag.mockReturnValue({ mutateAsync: deleteMutate, isPending: false });
});

describe('ConversationTags', () => {
  it('renders the empty state and count when no tags are assigned', () => {
    renderTags();
    expect(screen.getByText('No tags yet.')).toBeInTheDocument();
    expect(screen.getByText('0/5')).toBeInTheDocument();
    expect(screen.getByText('conversation.addTag')).toBeInTheDocument();
  });

  it('renders assigned tags as removable chips', () => {
    renderTags(makeConversation([assignedTag('j1', LIBRARY[0]!)]));
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('1/5')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove VIP')).toBeInTheDocument();
    expect(screen.queryByText('No tags yet.')).not.toBeInTheDocument();
  });

  it('removes an assigned tag via the chip button and broadcasts', async () => {
    renderTags(makeConversation([assignedTag('j1', LIBRARY[0]!)]));
    await userEvent.click(screen.getByLabelText('Remove VIP'));
    await waitFor(() =>
      expect(removeMutate).toHaveBeenCalledWith({ junctionId: 'j1', conversationId: 'c1' }),
    );
    await waitFor(() => expect(emit).toHaveBeenCalled());
  });

  it('opens the inline editor and lists library tags', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    // Input focused and the library tags shown as options.
    expect(screen.getByLabelText('Search or create a tag')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });

  it('assigns an existing tag from the picker', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.click(screen.getByText('Refund'));
    await waitFor(() =>
      expect(addMutate).toHaveBeenCalledWith({ conversationId: 'c1', tagId: 'tg2' }),
    );
    await waitFor(() => expect(emit).toHaveBeenCalled());
  });

  it('filters the list by query and shows the create row for a new name', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.type(screen.getByLabelText('Search or create a tag'), 'Brand New');
    // Non-matching filters everything out; a create affordance appears.
    expect(screen.queryByText('VIP')).not.toBeInTheDocument();
    expect(screen.getByText('Create “Brand New”')).toBeInTheDocument();
  });

  it('creates and assigns a new tag from the create row', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.type(screen.getByLabelText('Search or create a tag'), 'Brand New');
    await userEvent.click(screen.getByText('Create “Brand New”'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledWith({ name: 'Brand New' }));
    await waitFor(() =>
      expect(addMutate).toHaveBeenCalledWith({ conversationId: 'c1', tagId: 'new1' }),
    );
  });

  it('resolves an exact existing name to that tag instead of creating (Enter)', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    const input = screen.getByLabelText('Search or create a tag');
    await userEvent.type(input, 'Refund');
    // Exact match: no create row shown.
    expect(screen.queryByText('Create “Refund”')).not.toBeInTheDocument();
    await userEvent.type(input, '{Enter}');
    await waitFor(() =>
      expect(addMutate).toHaveBeenCalledWith({ conversationId: 'c1', tagId: 'tg2' }),
    );
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('closes the editor on Escape', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    const input = screen.getByLabelText('Search or create a tag');
    await userEvent.type(input, '{Escape}');
    await waitFor(() =>
      expect(screen.queryByLabelText('Search or create a tag')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('conversation.addTag')).toBeInTheDocument();
  });

  it('closes the editor via the Done button', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.click(screen.getByText('Done'));
    await waitFor(() =>
      expect(screen.queryByLabelText('Search or create a tag')).not.toBeInTheDocument(),
    );
  });

  it('marks already-assigned tags as Added and toggles them back off', async () => {
    renderTags(makeConversation([assignedTag('j1', LIBRARY[0]!)]));
    await userEvent.click(screen.getByText('conversation.addTag'));
    const added = screen.getByText('Added');
    expect(added).toBeInTheDocument();
    // Clicking the assigned option in the picker unassigns it (uses junction id).
    // The picker option is the button that also contains the "Added" marker,
    // distinguishing it from the removable chip that shares the "VIP" text.
    await userEvent.click(added.closest('button')!);
    await waitFor(() =>
      expect(removeMutate).toHaveBeenCalledWith({ junctionId: 'j1', conversationId: 'c1' }),
    );
  });

  it('shows the empty-library hint when the library has no tags', async () => {
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    expect(screen.getByText('No tags yet — type to create one.')).toBeInTheDocument();
  });

  it('blocks opening the editor at the 5-tag cap and shows the limit message', async () => {
    const full = makeConversation([
      assignedTag('j1', { id: 't1', name: 'A', color: null }),
      assignedTag('j2', { id: 't2', name: 'B', color: null }),
      assignedTag('j3', { id: 't3', name: 'C', color: null }),
      assignedTag('j4', { id: 't4', name: 'D', color: null }),
      assignedTag('j5', { id: 't5', name: 'E', color: null }),
    ]);
    renderTags(full);
    expect(screen.getByText('5/5')).toBeInTheDocument();
    // At the cap the add button is replaced by the limit message.
    expect(screen.getByText('Up to 5 tags per conversation.')).toBeInTheDocument();
    expect(screen.queryByText('conversation.addTag')).not.toBeInTheDocument();
  });

  it('surfaces an error toast when assigning fails', async () => {
    addMutate.mockRejectedValueOnce(new Error('boom'));
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.click(screen.getByText('Refund'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.updateFailed'));
  });

  it('surfaces an error toast when removing fails', async () => {
    removeMutate.mockRejectedValueOnce(new Error('boom'));
    renderTags(makeConversation([assignedTag('j1', LIBRARY[0]!)]));
    await userEvent.click(screen.getByLabelText('Remove VIP'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.updateFailed'));
  });

  it('deletes a tag from the library after confirming', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.click(screen.getByLabelText('Delete “VIP” from the library'));
    // ConfirmDialog opens; confirm the destructive delete. The confirm label
    // resolves to its defaultValue ("Delete") through the mocked translator.
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('tg1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('cancels the delete confirmation without deleting', async () => {
    renderTags();
    await userEvent.click(screen.getByText('conversation.addTag'));
    await userEvent.click(screen.getByLabelText('Delete “VIP” from the library'));
    await userEvent.click(screen.getByRole('button', { name: 'actions.cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'actions.delete' })).not.toBeInTheDocument(),
    );
    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
