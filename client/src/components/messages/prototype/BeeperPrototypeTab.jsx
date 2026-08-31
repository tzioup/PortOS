/* PROTOTYPE — issue #9 (https://github.com/tzioup/PortOS/issues/9). THROWAWAY.
 *
 * Three variants of the Beeper tab in Comms, switchable via `?variant=` on the
 * existing /messages route, against invented fixtures. Not production code: no
 * tests, no error handling, no network calls, nothing persisted.
 *
 * The question: does a unified cross-network conversation list read well at
 * all, or does the network need to be louder than a badge?
 *
 *   A  badge on the avatar      network is a detail
 *   B  rail down the left       network is the axis
 *   C  collapsible groups       network is the structure
 *
 * `?scenario=` matters as much as `?variant=`. This machine's 9 networks are an
 * outlier; judge every variant at 1 and 5 as well, plus the degraded states.
 */
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { buildScenario, SCENARIOS } from './beeperFixtures';
import { OfflinePanel } from './beeperProtoKit';
import VariantA, { variantName as nameA } from './BeeperVariantA';
import VariantB, { variantName as nameB } from './BeeperVariantB';
import VariantC, { variantName as nameC } from './BeeperVariantC';

const VARIANTS = [
  { key: 'A', name: nameA, Component: VariantA },
  { key: 'B', name: nameB, Component: VariantB },
  { key: 'C', name: nameC, Component: VariantC },
];

const BASE = '/messages/beeper-proto';

function PrototypeBar({ variantKey, onVariant, scenarioId, onScenario }) {
  const idx = VARIANTS.findIndex((v) => v.key === variantKey);
  const cycle = (delta) => onVariant(VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length].key);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      cycle(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pointer-events-auto fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-amber-400 bg-neutral-900 px-2 py-1.5 shadow-xl">
      <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-900">
        Prototype
      </span>
      <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant" className="px-1.5 text-neutral-300 hover:text-white">←</button>
      <span className="whitespace-nowrap text-xs font-medium text-neutral-100">
        {variantKey} · {VARIANTS[idx]?.name}
      </span>
      <button type="button" onClick={() => cycle(1)} aria-label="Next variant" className="px-1.5 text-neutral-300 hover:text-white">→</button>
      <span className="mx-1 h-4 w-px bg-neutral-700" />
      <select
        value={scenarioId}
        onChange={(e) => onScenario(e.target.value)}
        aria-label="Prototype scenario"
        className="max-w-56 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 focus:outline-none"
      >
        {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </div>
  );
}

export default function BeeperPrototypeTab() {
  const navigate = useNavigate();
  const { chatKey } = useParams();
  const [params, setParams] = useSearchParams();

  const variantKey = VARIANTS.some((v) => v.key === params.get('variant')) ? params.get('variant') : 'A';
  const scenarioId = SCENARIOS.some((s) => s.id === params.get('scenario')) ? params.get('scenario') : 'nine';
  const scenario = buildScenario(scenarioId);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  // Selection lives in the URL (client/src/AGENTS.md), as the real tab will:
  // /messages/beeper-proto/:chatKey. Switching scenario can strand a selection
  // that no longer exists, so drop it rather than render a dead thread.
  const selected = scenario.conversations.some((c) => c.id === chatKey) ? chatKey : null;
  useEffect(() => {
    if (chatKey && !selected) navigate(`${BASE}?${params}`, { replace: true });
  }, [chatKey, selected, navigate, params]);

  const onSelect = (id) => navigate(id ? `${BASE}/${id}?${params}` : `${BASE}?${params}`);

  const { Component } = VARIANTS.find((v) => v.key === variantKey);

  return (
    <div className="relative h-full min-h-0">
      {scenario.reachable
        ? <Component scenario={scenario} selected={selected} onSelect={onSelect} />
        : <OfflinePanel onRetry={() => setParam('scenario', 'nine')} />}
      <PrototypeBar
        variantKey={variantKey}
        onVariant={(k) => setParam('variant', k)}
        scenarioId={scenarioId}
        onScenario={(s) => setParam('scenario', s)}
      />
    </div>
  );
}
