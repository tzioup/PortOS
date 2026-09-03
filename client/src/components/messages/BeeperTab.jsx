import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import useBeeperRealtime from '../../hooks/useBeeperRealtime';
import useMounted from '../../hooks/useMounted';
import { getBeeperStatus } from '../../services/api';
import BeeperChatSurface from './beeper/BeeperChatSurface';
import BeeperSettingsPanel from './beeper/BeeperSettingsPanel';

/**
 * Comms → Messages → Beeper. The page shell for the chat surface (#35).
 *
 * It owns exactly two things the surface and the settings panel must share:
 *
 *  1. **The one realtime subscription.** `useBeeperRealtime` emits
 *     `beeper:unsubscribe` on unmount, so a second instance inside the settings
 *     drawer would tear the surface's subscription down every time the drawer
 *     closed. One subscriber per page, and the liveness snapshot plus an
 *     invalidation counter are handed down as props.
 *  2. **The settings drawer.** #30's status card is not removed by the chat
 *     surface landing — it moves behind a header action, deep-linked as
 *     `?settings=1` exactly like the iMessage ingestion drawer, so ⌘K and voice
 *     can open it and an actionable fault still has a home that is not a
 *     global banner.
 *
 * The open conversation is the route param on `/messages/beeper/:conversationId`
 * (Messages routes it as the shared `:chatKey` segment), never local state.
 */
export default function BeeperTab() {
  const { chatKey } = useParams();
  const [settingsParam, setSettingsParam] = useDrawerTab('settings', null, ['1']);
  // A counter rather than the frame itself: the frames are invalidation-only
  // (#33) and carry no rows, so the only information the surface needs from one
  // is "something changed, re-read the mirror".
  const [invalidationSeq, setInvalidationSeq] = useState(0);
  const [seededRealtime, setSeededRealtime] = useState(null);

  const mountedRef = useMounted();
  const onInvalidate = useCallback(() => setInvalidationSeq((seq) => seq + 1), []);
  const { realtime, seedRealtime } = useBeeperRealtime({ onInvalidate });

  // The status GET carries the same liveness snapshot the socket reports, so
  // the dot is correct before the first frame lands rather than blank until
  // something changes. `seedRealtime` no-ops once the socket has spoken.
  const handleRealtimeSeed = useCallback((state) => {
    seedRealtime(state);
    setSeededRealtime(state);
  }, [seedRealtime]);

  // Seeded from the page, not from the settings drawer: `beeper:subscribe`
  // does not push the current transport state, and the drawer's own status
  // fetch only runs once it is opened — so without this the rail's dot would
  // stay blank on a healthy install until something changed.
  const seedStatus = useCallback(() => {
    getBeeperStatus({ silent: true })
      .then((status) => { if (mountedRef.current && status?.realtime) handleRealtimeSeed(status.realtime); })
      .catch(() => {});
  }, [handleRealtimeSeed, mountedRef]);

  useEffect(() => { seedStatus(); }, [seedStatus]);

  // Beeper redirects the BROWSER back to this PAGE after consent (#31), not to
  // the settings drawer — so the outcome flag is read here, where something is
  // always mounted, rather than in the panel that only exists while the drawer
  // is open. The server callback already exchanged the code and vaulted the
  // token; all that arrives is the outcome. Report it once, then strip it so a
  // reload doesn't repeat the toast, and on a FAILURE open the settings drawer
  // in the same URL write, because that is where the connect card that fixes it
  // lives.
  const [searchParams, setSearchParams] = useSearchParams();
  const oauthConnected = searchParams.get('beeperConnected');
  const oauthError = searchParams.get('beeperOauthError');
  useEffect(() => {
    if (!oauthConnected && !oauthError) return;
    if (oauthError) toast.error(`Beeper connect failed: ${oauthError}`);
    else {
      toast.success('Beeper connected');
      seedStatus();
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('beeperConnected');
      next.delete('beeperOauthError');
      if (oauthError) next.set('settings', '1');
      return next;
    }, { replace: true });
  }, [oauthConnected, oauthError, setSearchParams, seedStatus]);

  return (
    <div className="h-full min-h-0">
      <BeeperChatSurface
        conversationId={chatKey || null}
        realtime={realtime || seededRealtime}
        invalidationSeq={invalidationSeq}
        onOpenSettings={() => setSettingsParam('1')}
      />

      <Drawer
        open={settingsParam === '1'}
        onClose={() => setSettingsParam(null)}
        title="Beeper Settings"
        size="md"
      >
        <BeeperSettingsPanel realtime={realtime} onRealtimeSeed={handleRealtimeSeed} />
      </Drawer>
    </div>
  );
}
