// PROTOTYPE — issue #9. Smoke check only: proves the surface mounts in every
// scenario and holds the two rules that are requirements rather than styling,
// so the principal never opens a blank or a lying page. Deleted with the folder.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import BeeperPrototypeTab from './BeeperPrototypeTab';
import { SCENARIOS } from './beeperFixtures';

const at = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/messages/:tab/:chatKey" element={<BeeperPrototypeTab />} />
      <Route path="/messages/:tab" element={<BeeperPrototypeTab />} />
    </Routes>
  </MemoryRouter>,
);

describe('beeper prototype smoke', () => {
  for (const s of SCENARIOS) {
    it(`renders the ${s.id} install`, () => {
      const { unmount } = at(`/messages/beeper-proto?scenario=${s.id}`);
      expect(screen.getByText('Prototype')).toBeTruthy();
      unmount();
    });
  }

  it('badges rows with their network in the unified inbox', () => {
    at('/messages/beeper-proto?scenario=nine&scope=all');
    expect(screen.getAllByTestId('network-badge').length).toBeGreaterThan(0);
  });

  it('drops every row badge inside a single-network scope', () => {
    at('/messages/beeper-proto?scenario=nine&scope=whatsapp');
    // The rail already states the network, so a per-row badge is pure noise.
    expect(screen.queryAllByTestId('network-badge')).toHaveLength(0);
    expect(screen.getByText('WhatsApp')).toBeTruthy(); // the scope header still names it
  });

  it('names the network and its transport in the composer', () => {
    at('/messages/beeper-proto/c7?scenario=nine');
    expect(screen.getByPlaceholderText(/on Google Messages \(RCS\)$/)).toBeTruthy();
  });

  it('disables send when the conversation’s bridge is disconnected', () => {
    at('/messages/beeper-proto/c1?scenario=degraded');
    expect(screen.getByPlaceholderText(/can’t send/)).toBeDisabled();
  });
});
