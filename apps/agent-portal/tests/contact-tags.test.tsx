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

// Stub the shared UI package: `toast.error` lets us assert failure paths and
// `CloseIcon` renders a marker so the remove buttons stay clickable.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('@yiji/ui', () => ({
  toast: { error: toastError },
  CloseIcon: () => <span data-testid="close-icon">x</span>,
}));

// The tag library hooks (list + create) come from the inbox api module.
const inbox = vi.hoisted(() => ({
  useTags: vi.fn(),
  useCreateTag: vi.fn(),
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

// The junction-level add/remove mutations come from the contacts api module.
const contactsApi = vi.hoisted(() => ({
  useAddTagToContact: vi.fn(),
  useRemoveTagFromContact: vi.fn(),
}));
vi.mock('../src/features/contacts/api.js', () => contactsApi);

import { ContactTags } from '../src/features/contacts/ContactTags.js';

type ContactRow = React.ComponentProps<typeof ContactTags>['contact'];

function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 'k1',
    external_customer_id: null,
    name: 'Alice',
    phone: null,
    email: null,
    metadata: null,
    vendor: null,
    date_created: null,
    tags: [],
    ...overrides,
  } as ContactRow;
}

function renderTags(contact: ContactRow) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ContactTags contact={contact} />, { wrapper: Wrapper });
}

// Sensible defaults; individual tests override via mockReturnValue.
const addMutate = vi.fn();
const removeMutate = vi.fn();
const createMutate = vi.fn();

beforeEach(() => {
  toastError.mockReset();
  addMutate.mockReset().mockResolvedValue({});
  removeMutate.mockReset().mockResolvedValue({});
  createMutate.mockReset().mockResolvedValue({ id: 'new-tag' });

  inbox.useTags.mockReset().mockReturnValue({ data: [] });
  inbox.useCreateTag.mockReset().mockReturnValue({ mutateAsync: createMutate });
  contactsApi.useAddTagToContact.mockReset().mockReturnValue({ mutateAsync: addMutate });
  contactsApi.useRemoveTagFromContact.mockReset().mockReturnValue({ mutateAsync: removeMutate });
});

describe('ContactTags', () => {
  it('shows the empty state when the contact has no tags', () => {
    renderTags(makeContact({ tags: [] }));
    expect(screen.getByText('No tags yet.')).toBeInTheDocument();
    expect(screen.getByText('Add tag')).toBeInTheDocument();
  });

  it('renders the assigned tag chips (and skips junctions without a tag)', () => {
    renderTags(
      makeContact({
        tags: [
          { id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } },
          { id: 'j2', tags_id: { id: 'tg2', name: 'Lead', color: null } },
          // A dangling junction with no tag should be filtered out.
          { id: 'j3', tags_id: null },
        ],
      }),
    );
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Lead')).toBeInTheDocument();
    // Empty-state copy must not show when tags exist.
    expect(screen.queryByText('No tags yet.')).not.toBeInTheDocument();
  });

  it('opens the editor and lists available (unassigned) tags to pick from', async () => {
    inbox.useTags.mockReturnValue({
      data: [
        { id: 'tg1', name: 'VIP', color: '#f00' },
        { id: 'tg2', name: 'Lead', color: null },
      ],
    });
    renderTags(
      makeContact({
        tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } }],
      }),
    );
    await userEvent.click(screen.getByText('Add tag'));
    // VIP already assigned -> only Lead is offered in the picker.
    expect(screen.getByText('Lead')).toBeInTheDocument();
  });

  it('assigns an existing tag when picked from the list', async () => {
    inbox.useTags.mockReturnValue({
      data: [{ id: 'tg2', name: 'Lead', color: null }],
    });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    await userEvent.click(screen.getByText('Lead'));
    await waitFor(() => expect(addMutate).toHaveBeenCalledWith({ contactId: 'k1', tagId: 'tg2' }));
  });

  it('creates and assigns a brand-new tag when typing a novel name', async () => {
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    const input = screen.getByPlaceholderText('Search or create…');
    await userEvent.type(input, 'Fresh');
    // The "Create ..." affordance appears because no exact match exists.
    await userEvent.click(screen.getByText('Create “Fresh”'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledWith({ name: 'Fresh' }));
    await waitFor(() =>
      expect(addMutate).toHaveBeenCalledWith({ contactId: 'k1', tagId: 'new-tag' }),
    );
  });

  it('reuses an existing tag (by name) instead of creating a duplicate', async () => {
    inbox.useTags.mockReturnValue({
      data: [{ id: 'tg2', name: 'Lead', color: null }],
    });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    const input = screen.getByPlaceholderText('Search or create…');
    // Type the exact (case-insensitive) name of an existing, unassigned tag.
    await userEvent.type(input, 'lead{Enter}');
    await waitFor(() => expect(addMutate).toHaveBeenCalledWith({ contactId: 'k1', tagId: 'tg2' }));
    // Must NOT create a new tag when one already exists by that name.
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('is a no-op when the typed name matches an already-assigned tag', async () => {
    inbox.useTags.mockReturnValue({
      data: [{ id: 'tg1', name: 'VIP', color: '#f00' }],
    });
    renderTags(
      makeContact({
        tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } }],
      }),
    );
    await userEvent.click(screen.getByText('Add tag'));
    const input = screen.getByPlaceholderText('Search or create…');
    await userEvent.type(input, 'vip{Enter}');
    // Already assigned -> neither create nor add fires.
    expect(createMutate).not.toHaveBeenCalled();
    expect(addMutate).not.toHaveBeenCalled();
  });

  it('removes an assigned tag via its remove button', async () => {
    renderTags(
      makeContact({
        tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } }],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove VIP' }));
    await waitFor(() =>
      expect(removeMutate).toHaveBeenCalledWith({ junctionId: 'j1', contactId: 'k1' }),
    );
  });

  it('shows an error toast when adding a tag fails', async () => {
    addMutate.mockRejectedValue(new Error('boom'));
    inbox.useTags.mockReturnValue({
      data: [{ id: 'tg2', name: 'Lead', color: null }],
    });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    await userEvent.click(screen.getByText('Lead'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('shows an error toast when removing a tag fails', async () => {
    removeMutate.mockRejectedValue(new Error('boom'));
    renderTags(
      makeContact({
        tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } }],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove VIP' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('shows an error toast when create-and-assign fails', async () => {
    createMutate.mockRejectedValue(new Error('boom'));
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    await userEvent.type(screen.getByPlaceholderText('Search or create…'), 'Fresh{Enter}');
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('shows the "all tags added" hint when every tag is assigned and no query', async () => {
    inbox.useTags.mockReturnValue({
      data: [{ id: 'tg1', name: 'VIP', color: '#f00' }],
    });
    renderTags(
      makeContact({
        tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: '#f00' } }],
      }),
    );
    await userEvent.click(screen.getByText('Add tag'));
    expect(screen.getByText('All tags added — type to create a new one.')).toBeInTheDocument();
  });

  it('closes the editor via the Done button', async () => {
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    expect(screen.getByPlaceholderText('Search or create…')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Done'));
    // Back to the collapsed state.
    expect(screen.queryByPlaceholderText('Search or create…')).not.toBeInTheDocument();
    expect(screen.getByText('Add tag')).toBeInTheDocument();
  });

  it('closes the editor when Escape is pressed', async () => {
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    const input = screen.getByPlaceholderText('Search or create…');
    await userEvent.type(input, '{Escape}');
    expect(screen.queryByPlaceholderText('Search or create…')).not.toBeInTheDocument();
  });

  it('does not create/assign when Enter is pressed with a blank query', async () => {
    inbox.useTags.mockReturnValue({ data: [] });
    renderTags(makeContact({ tags: [] }));
    await userEvent.click(screen.getByText('Add tag'));
    const input = screen.getByPlaceholderText('Search or create…');
    await userEvent.type(input, '{Enter}');
    expect(createMutate).not.toHaveBeenCalled();
    expect(addMutate).not.toHaveBeenCalled();
  });

  it('treats a contact with no tags array as empty', () => {
    renderTags(makeContact({ tags: undefined }));
    expect(screen.getByText('No tags yet.')).toBeInTheDocument();
  });
});
