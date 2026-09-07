/**
 * Messages page — Beeper tab visibility (#30, real-browser pass).
 *
 * TABS in Messages.jsx is a static array, so the tab-strip render must filter
 * it through the same instance-feature hook the sidebar uses (`useInstanceFeatures`
 * + `filterNavByFeatures`) or the Beeper pill shows — and is clickable — even
 * when the instance feature is off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../components/messages/InboxTab', () => ({ default: () => <div>inbox panel</div> }));
vi.mock('../components/messages/ConfigTab', () => ({ default: () => <div>config panel</div> }));
vi.mock('../components/messages/DraftsTab', () => ({ default: () => <div>drafts panel</div> }));
vi.mock('../components/messages/SyncTab', () => ({ default: () => <div>sync panel</div> }));
vi.mock('../components/messages/IMessageTab', () => ({ default: () => <div>imessage panel</div> }));
vi.mock('../components/messages/SignalTab', () => ({ default: () => <div>signal panel</div> }));
vi.mock('../components/messages/BeeperTab', () => ({ default: () => <div>beeper panel</div> }));
vi.mock('../components/messages/ContactsTab', () => ({ default: () => <div>contacts panel</div> }));

const featureMock = vi.hoisted(() => ({ features: [{ id: 'beeper', label: 'Beeper', enabled: true }] }));

vi.mock('../services/api', () => ({
  getMessageAccounts: vi.fn(() => Promise.resolve([])),
  getInstanceFeatures: vi.fn(() => Promise.resolve({ features: featureMock.features })),
}));

import { __resetInstanceFeatureCache } from '../hooks/useInstanceFeatures.js';
import Messages from './Messages';

beforeEach(() => {
  __resetInstanceFeatureCache();
  featureMock.features = [{ id: 'beeper', label: 'Beeper', enabled: true }];
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/messages/:tab" element={<Messages />} />
      <Route path="/messages/:tab/:chatKey" element={<Messages />} />
    </Routes>
  </MemoryRouter>,
);

describe('Messages — Beeper tab gating', () => {
  it('shows the Beeper pill in the tab strip when the beeper feature is on', async () => {
    renderAt('/messages/inbox');

    const beeper = await screen.findByRole('tab', { name: /Beeper/i });
    expect(beeper).toBeTruthy();
  });

  it('hides the Beeper pill from the tab strip when the beeper feature is off', async () => {
    featureMock.features = [{ id: 'beeper', label: 'Beeper', enabled: false }];

    renderAt('/messages/inbox');

    // Other Comms pills stay put — only Beeper drops.
    expect(await screen.findByRole('tab', { name: /^Signal$/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Beeper/i })).toBeNull();
  });

  it('still renders the Beeper panel for a direct/bookmarked link even with the feature off', async () => {
    featureMock.features = [{ id: 'beeper', label: 'Beeper', enabled: false }];

    renderAt('/messages/beeper');

    expect(await screen.findByText('beeper panel')).toBeTruthy();
  });
});

describe('Messages — Comms group gating (iMessage, Signal)', () => {
  // F3: iMessage and Signal joined the Comms group's nav-manifest gate (#40)
  // but the Messages tab strip only tagged the Beeper row with `feature`, so
  // the pills stayed visible and clickable with the group off — the exact
  // inconsistency the Beeper pill's own comment says must not exist.
  it('hides the iMessage and Signal pills from the tab strip when the comms group is off', async () => {
    featureMock.features = [
      { id: 'imessage', label: 'iMessage', enabled: false },
      { id: 'signal', label: 'Signal', enabled: false },
      { id: 'beeper', label: 'Beeper', enabled: false },
    ];

    renderAt('/messages/inbox');

    // A non-comms pill stays put as the control.
    expect(await screen.findByRole('tab', { name: 'Inbox' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /iMessage/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^Signal$/i })).toBeNull();
  });

  it('shows only the Signal pill when iMessage is overridden off and Signal is on', async () => {
    featureMock.features = [
      { id: 'imessage', label: 'iMessage', enabled: false },
      { id: 'signal', label: 'Signal', enabled: true },
    ];

    renderAt('/messages/inbox');

    expect(await screen.findByRole('tab', { name: /^Signal$/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /iMessage/i })).toBeNull();
  });

  // Parity with Beeper (#30/#40): the feature gates the tab strip and the
  // sidebar, never the <Route> itself, so a direct/bookmarked visit still
  // renders the tab body while the feature is off — see the equivalent Beeper
  // case in 'Messages — Beeper tab gating' above. iMessage matches that
  // existing behavior rather than gaining a new, stricter route-level gate.
  it('still renders the iMessage panel for a direct/bookmarked link even with the feature off', async () => {
    featureMock.features = [{ id: 'imessage', label: 'iMessage', enabled: false }];

    renderAt('/messages/imessage');

    expect(await screen.findByText('imessage panel')).toBeTruthy();
  });
});

describe('Messages — header account count scope (#30/#35)', () => {
  // The header's "N accounts" reads the generic email-provider account list
  // (Gmail/Outlook/Teams), not Beeper's own roster — it must not render on a
  // tab that has nothing to do with that list, or it reads as a (wrong) Beeper
  // account count. #35 real-browser pass: it showed "0 accounts" on the Beeper
  // tab while the Beeper mirror held nine.
  it('does not show the provider-account count on the Beeper tab', async () => {
    renderAt('/messages/beeper');

    await screen.findByText('beeper panel');
    expect(screen.queryByText(/accounts?$/i)).toBeNull();
  });

  it('still shows the provider-account count on tabs that use it (Inbox)', async () => {
    renderAt('/messages/inbox');

    await screen.findByText('inbox panel');
    expect(await screen.findByText('0 accounts')).toBeTruthy();
  });
});
