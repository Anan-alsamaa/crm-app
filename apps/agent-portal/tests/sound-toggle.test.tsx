import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// Stub the UI package so the icons/cn helper don't drag in real styling deps.
vi.mock('@yiji/ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  SoundOnIcon: () => <span data-testid="sound-on-icon" />,
  SoundOffIcon: () => <span data-testid="sound-off-icon" />,
}));

const sound = vi.hoisted(() => ({
  isSoundMuted: vi.fn(),
  setSoundMuted: vi.fn(),
  playMessageBeep: vi.fn(),
}));
vi.mock('../src/lib/sound.js', () => sound);

import { SoundToggle } from '../src/components/SoundToggle.js';

beforeEach(() => {
  sound.isSoundMuted.mockReset();
  sound.setSoundMuted.mockReset();
  sound.playMessageBeep.mockReset();
});

describe('SoundToggle', () => {
  it('renders the "on" icon and mute label when sound is on', () => {
    sound.isSoundMuted.mockReturnValue(false);
    render(<SoundToggle />);
    const btn = screen.getByRole('button');
    expect(screen.getByTestId('sound-on-icon')).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('aria-label', 'Mute new-message sound');
  });

  it('renders the "off" icon and unmute label when sound is muted', () => {
    sound.isSoundMuted.mockReturnValue(true);
    render(<SoundToggle />);
    const btn = screen.getByRole('button');
    expect(screen.getByTestId('sound-off-icon')).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('aria-label', 'Unmute new-message sound');
  });

  it('unmuting (on -> off? no: muted -> unmuted) persists and plays a confirming beep', async () => {
    // Start muted; clicking unmutes -> next=false -> plays the beep.
    sound.isSoundMuted.mockReturnValue(true);
    render(<SoundToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(sound.setSoundMuted).toHaveBeenCalledWith(false);
    expect(sound.playMessageBeep).toHaveBeenCalledTimes(1);
    // The icon flips to the "on" state after unmuting.
    expect(screen.getByTestId('sound-on-icon')).toBeInTheDocument();
  });

  it('muting persists and does NOT play a beep', async () => {
    // Start unmuted; clicking mutes -> next=true -> no beep.
    sound.isSoundMuted.mockReturnValue(false);
    render(<SoundToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(sound.setSoundMuted).toHaveBeenCalledWith(true);
    expect(sound.playMessageBeep).not.toHaveBeenCalled();
    expect(screen.getByTestId('sound-off-icon')).toBeInTheDocument();
  });
});
