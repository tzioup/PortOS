// PROTOTYPE — issue #9. Smoke check only: proves every variant x scenario mounts,
// so the principal never opens a blank page. Deleted with the rest of the folder.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import BeeperPrototypeTab from './BeeperPrototypeTab';
import { SCENARIOS } from './beeperFixtures';

const mount = (search) => render(
  <MemoryRouter initialEntries={[`/messages/beeper-proto${search}`]}>
    <Routes>
      <Route path="/messages/:tab/:chatKey" element={<BeeperPrototypeTab />} />
      <Route path="/messages/:tab" element={<BeeperPrototypeTab />} />
    </Routes>
  </MemoryRouter>,
);

describe('beeper prototype smoke', () => {
  for (const v of ['A', 'B', 'C']) {
    for (const s of SCENARIOS) {
      it(`renders ${v} / ${s.id}`, () => {
        const { unmount } = mount(`?variant=${v}&scenario=${s.id}`);
        expect(screen.getByText('Prototype')).toBeTruthy();
        unmount();
      });
    }
  }

  it('opens a thread from the URL and names the network in the composer', () => {
    render(
      <MemoryRouter initialEntries={['/messages/beeper-proto/c1?variant=A&scenario=nine']}>
        <Routes><Route path="/messages/:tab/:chatKey" element={<BeeperPrototypeTab />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText(/on WhatsApp/)).toBeTruthy();
    expect(screen.getAllByText('ok that works — 3pm your time?').length).toBe(2); // list preview + last bubble
  });

  it('disables send when the conversation’s bridge is disconnected', () => {
    render(
      <MemoryRouter initialEntries={['/messages/beeper-proto/c4?variant=B&scenario=degraded']}>
        <Routes><Route path="/messages/:tab/:chatKey" element={<BeeperPrototypeTab />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText(/can’t send/)).toBeDisabled();
  });
});
