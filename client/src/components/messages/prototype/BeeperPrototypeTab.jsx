/* PROTOTYPE — issue #9 (https://github.com/tzioup/PortOS/issues/9). THROWAWAY.
 *
 * The Beeper tab in Comms, reproduced from the reference interface (Beeper
 * Desktop) and mounted on the existing /messages route against invented
 * fixtures. Not production code: no network calls, nothing persisted,
 * unreachable in a production build.
 *
 * There is deliberately only ONE layout. The reference is already validated by
 * daily use, so the open question is not "what should this look like" but "what
 * does it look like once it is PortOS, at install sizes and in failure states
 * Beeper Desktop cannot show us" — which is what `?scenario=` is for.
 *
 * URL contract, matching client/src/AGENTS.md and what the real tab must meet:
 *   /messages/beeper-proto/:chatKey?scope=<network|all>&scenario=<id>
 */
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PlugZap } from 'lucide-react';
import { buildScenario, SCENARIOS } from './beeperFixtures';
import BeeperSurface from './BeeperSurface';

const BASE = '/messages/beeper-proto';

function PrototypeBar({ scenarioId, onScenario }) {
  return (
    <div className="pointer-events-auto fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-amber-400 bg-neutral-900 px-2.5 py-1.5 shadow-xl">
      <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-900">
        Prototype
      </span>
      <label htmlFor="proto-scenario" className="text-[11px] text-neutral-400">Install</label>
      <select
        id="proto-scenario"
        value={scenarioId}
        onChange={(e) => onScenario(e.target.value)}
        className="max-w-64 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 focus:outline-none"
      >
        {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </div>
  );
}

function OfflinePanel({ onRetry }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <PlugZap size={28} className="text-port-warning" />
      <p className="text-sm font-medium text-port-text">Can’t reach Beeper</p>
      <p className="max-w-md text-xs text-port-text-muted">
        Nothing answered on the local Beeper API. Open Beeper Desktop, or point PortOS at a different
        base URL if you run the headless server.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-port-text hover:border-port-accent"
      >
        Retry
      </button>
    </div>
  );
}

export default function BeeperPrototypeTab() {
  const navigate = useNavigate();
  const { chatKey } = useParams();
  const [params, setParams] = useSearchParams();

  const scenarioId = SCENARIOS.some((s) => s.id === params.get('scenario')) ? params.get('scenario') : 'nine';
  const scope = params.get('scope') || 'all';
  const scenario = buildScenario(scenarioId);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  // Selection lives in the URL, as the real tab will. Changing scenario can
  // strand a selection that no longer exists, so drop it rather than render a
  // dead thread.
  const selected = scenario.conversations.some((c) => c.id === chatKey) ? chatKey : null;
  useEffect(() => {
    if (chatKey && !selected) navigate(`${BASE}?${params}`, { replace: true });
  }, [chatKey, selected, navigate, params]);

  const onSelect = (id) => navigate(id ? `${BASE}/${id}?${params}` : `${BASE}?${params}`);

  return (
    <div className="relative h-full min-h-0">
      {scenario.reachable ? (
        <BeeperSurface
          scenario={scenario}
          selected={selected}
          onSelect={onSelect}
          scope={scope}
          onScope={(s) => setParam('scope', s)}
        />
      ) : (
        <OfflinePanel onRetry={() => setParam('scenario', 'nine')} />
      )}
      <PrototypeBar scenarioId={scenarioId} onScenario={(s) => setParam('scenario', s)} />
    </div>
  );
}
