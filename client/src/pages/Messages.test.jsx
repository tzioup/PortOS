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
