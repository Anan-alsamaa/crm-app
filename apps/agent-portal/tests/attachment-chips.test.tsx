import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Mock the directus lib so the test doesn't pull in the auth-client/browser
// storage chain — we only care about rendering here.
vi.mock('../src/lib/directus.js', () => ({ downloadAsset: vi.fn() }));

// Stub the authenticated blob hook so image thumbnails render deterministically
// without a real fetch.
vi.mock('../src/lib/useAssetBlobUrl.js', () => ({
  useAssetBlobUrl: (id: string, enabled: boolean) => ({
    url: enabled ? `blob:${id}` : null,
    loading: false,
    error: false,
  }),
}));

// Stub i18n (no provider in this unit test): return the defaultValue or key,
// interpolating {{name}} when provided.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; name?: string }) => {
      const dv = opts?.defaultValue ?? key;
      return opts?.name ? dv.replace('{{name}}', opts.name) : dv;
    },
  }),
}));

import { AttachmentChips } from '../src/features/conversation/AttachmentChips.js';

afterEach(() => cleanup());

describe('AttachmentChips', () => {
  it('renders an image as a thumbnail and a file as a typed download chip', () => {
    render(
      <AttachmentChips
        attachments={[
          { id: 'f1', filename: 'report.pdf', type: 'application/pdf', filesize: 245760 },
          { id: 'f2', filename: 'photo.png', type: 'image/png', filesize: 102400 },
        ]}
      />,
    );
    // PDF → typed file chip labelled by filename.
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    // PNG → image thumbnail (button labelled "Preview photo.png" + <img>).
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'photo.png');
    expect(screen.getByLabelText('Preview photo.png')).toBeInTheDocument();
    // One interactive control per attachment (file chip + image thumb).
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
