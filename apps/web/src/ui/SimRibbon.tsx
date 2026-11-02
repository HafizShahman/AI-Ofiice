import { toggleSim, useOffice } from '../store.ts';

/** UI-PLAN §3: a purple ribbon while the demo runs, so fake agents are never mistaken for real ones. */
export function SimRibbon() {
  const sim = useOffice((s) => s.sim);
  if (!sim) return null;
  return (
    <div data-ui role="status" className="absolute left-0 top-3 z-[1500] flex items-center gap-2 rounded-r-md border border-l-0 border-accent-2/60 bg-accent-2/20 py-1 pl-3 pr-2 font-mono text-[11px] tracking-[0.14em] text-[#f0abfc]">
      SIMULATION
      <button onClick={() => void toggleSim(false)} className="rounded border border-accent-2/50 px-1.5 py-0.5 text-[10px] tracking-normal hover:bg-accent-2/20">
        stop
      </button>
    </div>
  );
}
