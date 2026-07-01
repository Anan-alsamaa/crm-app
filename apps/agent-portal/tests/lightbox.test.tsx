import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// i18n stub: return the defaultValue (or key), matching the repo convention.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import { Lightbox } from '../src/components/Lightbox.js';

afterEach(() => cleanup());

describe('Lightbox', () => {
  it('renders the image, filename and formatted size in a modal dialog', () => {
    render(<Lightbox url="blob:abc" filename="photo.png" filesize={102400} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'photo.png');
    // filename shown in the top bar.
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    // formatBytes(102400) === '100 KB'.
    expect(screen.getByText('100 KB')).toBeInTheDocument();
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'blob:abc');
    expect(img).toHaveAttribute('alt', 'photo.png');
  });

  it('falls back to the "Attachment" label and empty alt when filename is null', () => {
    render(<Lightbox url="blob:abc" filename={null} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Attachment');
    expect(screen.getByText('Attachment')).toBeInTheDocument();
    // An empty-alt image has the "presentation" role, so query the element
    // directly rather than by the "img" role.
    const img = document.body.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
  });

  it('omits the size line when filesize is missing/invalid', () => {
    render(<Lightbox url="blob:abc" filename="x.png" filesize={null} onClose={() => {}} />);
    // formatBytes(null) === '' → no size <p>. Only the filename text exists.
    expect(screen.queryByText('100 KB')).not.toBeInTheDocument();
    expect(screen.getByText('x.png')).toBeInTheDocument();
  });

  it('does not render a download button when onDownload is absent', () => {
    render(<Lightbox url="blob:abc" filename="x.png" onClose={() => {}} />);
    expect(screen.queryByLabelText('Download')).not.toBeInTheDocument();
    // Only the close button.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders and fires the download action, stopping propagation to the backdrop', async () => {
    const onDownload = vi.fn();
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onDownload={onDownload} onClose={onClose} />);
    await userEvent.click(screen.getByLabelText('Download'));
    expect(onDownload).toHaveBeenCalledTimes(1);
    // Click did not bubble to the backdrop onClick handler.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the image itself is clicked', async () => {
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    await userEvent.click(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape (capture-phase window keydown)', () => {
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn();
    render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('always uses the latest onClose (ref) even after prop changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Lightbox url="blob:abc" filename="x.png" onClose={first} />);
    rerender(<Lightbox url="blob:abc" filename="x.png" onClose={second} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('locks background scroll while open and restores it on unmount', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(<Lightbox url="blob:abc" filename="x.png" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('removes the keydown listener on unmount (Escape no longer closes)', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Lightbox url="blob:abc" filename="x.png" onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders into document.body via a portal', () => {
    const { container } = render(<Lightbox url="blob:abc" filename="x.png" onClose={() => {}} />);
    // Portal: nothing lands in the mount container.
    expect(container).toBeEmptyDOMElement();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
