import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * The lazily-mirrored image attachment (#37, real-browser pass): while bytes
 * are in flight the `<img>` used to collapse to a 2x2px box (`complete: false`)
 * for the whole fetch — up to the 60s server timeout — before the onError path
 * ever rendered the reference row. This locks the reserved-space skeleton that
 * fills that gap, plus the load and error outcomes either side of it.
 */

const api = vi.hoisted(() => ({
  beeperAttachmentUrl: vi.fn((messageId, idx) => `/api/beeper/attachments/${messageId}/${idx}`),
  fetchBeeperAttachment: vi.fn(),
  setBeeperAttachmentKeep: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: toast }));

import BeeperAttachment from './BeeperAttachment';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseAttachment = {
  messageId: 'msg-1',
  idx: 0,
  mimeType: 'image/png',
  fileName: 'photo.png',
  byteLength: 204800,
  overCap: false,
  unavailable: false,
  stored: true,
};

describe('BeeperAttachment — image load lifecycle', () => {
  it('reserves space with a neutral skeleton while the mirror fetch is in flight, sized from width/height', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const skeleton = screen.getByTestId('attachment-skeleton');
    expect(skeleton).toBeTruthy();

    const img = screen.getByRole('img', { name: 'photo.png' });
    // Native width/height attributes reserve the real aspect ratio before load.
    expect(img).toHaveAttribute('width', '800');
    expect(img).toHaveAttribute('height', '600');
    // Hidden (opacity-0) until it loads, but still mounted so the fetch fires.
    expect(img.className).toContain('opacity-0');
  });

  it('falls back to a fixed neutral box when no width/height is known', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: null, height: null }} />);

    expect(screen.getByTestId('attachment-skeleton')).toBeTruthy();
    const img = screen.getByRole('img', { name: 'photo.png' });
    expect(img).not.toHaveAttribute('width');
    expect(img).not.toHaveAttribute('height');
  });

  it('swaps the skeleton for the image once it loads', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    fireEvent.load(img);

    expect(screen.queryByTestId('attachment-skeleton')).toBeNull();
    expect(img.className).toContain('opacity-100');
  });

  it('renders the reference row with a retry action on load failure, never a stuck skeleton', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    fireEvent.error(img);

    expect(screen.queryByTestId('attachment-skeleton')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/Could not load these bytes from Beeper/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});
