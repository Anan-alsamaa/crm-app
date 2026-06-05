import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Mock the directus lib so the test doesn't pull in the auth-client/browser
// storage chain — we only care about rendering here.
vi.mock('../src/lib/directus.js', () => ({ downloadAsset: vi.fn() }));

// Stub i18n (no provider in this unit test): return the defaultValue or key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import { AttachmentChips } from '../src/features/conversation/AttachmentChips.js';

afterEach(() => cleanup());

describe('AttachmentChips', () => {
  it('renders a download chip per attachment, labelled by filename', () => {
    render(
      <AttachmentChips
        attachments={[
          { id: 'f1', filename: 'report.pdf', type: 'application/pdf' },
          { id: 'f2', filename: 'photo.png', type: 'image/png' },
        ]}
      />,
    );
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('renders nothing when there are no attachments', () => {
    const { container } = render(<AttachmentChips attachments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when attachments is undefined', () => {
    const { container } = render(<AttachmentChips />);
    expect(container).toBeEmptyDOMElement();
  });
});
