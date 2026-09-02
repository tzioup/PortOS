import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Cpu, Gauge, Sparkles } from 'lucide-react';
import { getSystemCapabilities } from '../../services/api';

const APPLE_PROFILES = [
  {
    id: 'apple-48',
    minMemoryGb: 48,
    maxMemoryGb: 63,
    machine: '48 GB Apple Silicon',
    context: '64K context',
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Speed',
    note: 'Keeps the 27B coding agent responsive while leaving practical unified-memory headroom for PortOS and the harness.',
    alternatives: 'Slotstream is for the much larger SSD-streamed Flash-Next model, not this 27B coding path. llama.cpp remains the compatibility fallback.',
  },
  {
    id: 'apple-64',
    minMemoryGb: 64,
    maxMemoryGb: 127,
    machine: '64 GB Apple Silicon',
    context: '128K context',
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Speed',
    note: 'Uses native MTP speculative decoding for the standard local coding-agent setup, with room for a generous agent context.',
    alternatives: 'Use Slotstream only when deliberately running the SSD-streamed Flash-Next model. llama.cpp is the useful GGUF compatibility and tuning route.',
  },
  {
    id: 'apple-128',
    minMemoryGb: 128,
    machine: '128 GB Apple Silicon',
    context: '128K context',
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Quality',
    note: 'Prioritizes the quality checkpoint while retaining a long agent context on the largest supported Apple-memory tier.',
    alternatives: 'Slotstream is an optional path for the larger SSD-streamed Flash-Next model. Use llama.cpp when a GGUF or its speculative-decoding controls are required.',
  },
];

const RTX_3090_PROFILE = {
  id: 'rtx-3090',
  machine: 'Windows + NVIDIA RTX 3090 (24 GB VRAM)',
  context: '64K context',
  runtime: 'llama.cpp',
  harness: 'OpenCode llama TUI',
  model: 'Qwen3.8-27B GGUF (Q4)',
  note: 'Runs the 27B coding model directly on the 3090 through the mature GGUF path; use one request slot for an interactive coding agent.',
  alternatives: 'MTPLX and Slotstream are Apple-Silicon runtimes. Ollama is fine for a simpler general-purpose local setup, but this profile keeps llama.cpp controls available.',
};

/**
 * Select a deliberately small set of maintained, hardware-specific starting
 * profiles. This is separate from the catalog's per-model fit calculation:
 * fit answers whether a weight can run, while this answers which full runtime
 * and harness path PortOS has curated for a coding agent.
 */
export function hardwareLlmRecommendation(capabilities) {
  const memory = Number(capabilities?.totalMemoryGb);
  const gpuNames = (capabilities?.cuda?.gpus || []).map((gpu) => gpu?.name || '').join(' ');
  const maxVramGb = Number(capabilities?.cuda?.maxVramGb);
  if (capabilities?.platform === 'win32' && /rtx\s*3090/i.test(gpuNames) && maxVramGb >= 24) {
    return RTX_3090_PROFILE;
  }
  if (capabilities?.platform !== 'darwin' || capabilities?.appleSilicon !== true || !Number.isFinite(memory)) return null;
  return APPLE_PROFILES.find((profile) => memory >= profile.minMemoryGb && (profile.maxMemoryGb == null || memory <= profile.maxMemoryGb)) || null;
}

export default function HardwareLlmRecommendation() {
  const [capabilities, setCapabilities] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSystemCapabilities({ silent: true })
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const profile = hardwareLlmRecommendation(capabilities);
  if (!loaded) {
    return <div className="bg-port-card border border-port-border rounded-xl p-4 text-xs text-gray-500">Checking this machine for a curated coding-agent setup…</div>;
  }
  if (!profile) return null;

  return (
    <section className="bg-port-accent/5 border border-port-accent/40 rounded-xl p-4 sm:p-5 space-y-3" aria-labelledby="hardware-llm-recommendation-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-port-accent">
            <Sparkles size={16} />
            <h2 id="hardware-llm-recommendation-title" className="text-sm font-semibold">Recommended coding-agent setup</h2>
          </div>
          <p className="text-xs text-gray-400 mt-1">Curated for this machine: {profile.machine}</p>
        </div>
        <span className="text-[11px] px-2 py-1 rounded border border-port-accent/30 text-port-accent shrink-0">Qwen3.8-27B</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Runtime</span><p className="text-gray-200 mt-0.5 font-medium">{profile.runtime}</p></div>
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Harness</span><p className="text-gray-200 mt-0.5 font-medium">{profile.harness}</p></div>
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Launch target</span><p className="text-gray-200 mt-0.5 font-medium">{profile.context}</p></div>
      </div>

      <div className="text-xs text-gray-300 space-y-1.5 leading-relaxed">
        <p className="flex gap-2"><CheckCircle2 size={14} className="text-port-success shrink-0 mt-0.5" /><span><strong className="text-gray-200">Model:</strong> {profile.model}</span></p>
        <p className="flex gap-2"><Cpu size={14} className="text-gray-500 shrink-0 mt-0.5" /><span>{profile.note}</span></p>
        <p className="text-gray-500">{profile.alternatives}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Link to="/ai" className="text-port-accent hover:underline">Configure the harness in AI Providers</Link>
        <Link to="/models/performance" className="inline-flex items-center gap-1 text-port-accent hover:underline"><Gauge size={12} /> Validate with a local task check</Link>
      </div>
    </section>
  );
}
