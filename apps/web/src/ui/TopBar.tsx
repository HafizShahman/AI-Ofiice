import type { ReactNode } from 'react';
import { useSound } from '../sound/engine.ts';
import { previewVolume, toggleSound } from '../sound/cues.ts';
import { useDaylight, type Mode, type Phase } from '../scene/daylight.ts';
import { setAi, toggleSim, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { useCounts } from './util.tsx';

const chip = 'flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]';

const PHASE_LABEL: Record<Phase, string> = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };
const NEXT_MODE: Record<Mode, string> = { auto: 'Day', day: 'Night', night: 'Auto' };

function DayNightChip() {
  const mode = useDaylight((s) => s.mode);
  const phase = useDaylight((s) => s.phase);
  return (
    <button
      onClick={() => useDaylight.getState().cycle()}
      aria-label={`Lighting: ${mode === 'auto' ? `automatic, ${PHASE_LABEL[phase]}` : PHASE_LABEL[phase]}. Switch to ${NEXT_MODE[mode]}.`}
      title={`${mode === 'auto' ? 'Lighting follows your clock' : `Lighting pinned to ${PHASE_LABEL[phase].toLowerCase()}`}. Click for ${NEXT_MODE[mode]} (N)`}
      className={`${chip} rounded-full ${phase === 'night' ? 'border-border text-muted hover:text-text' : 'border-warning/40 bg-warning/8 text-warning'}`}
    >
      <Icon name={phase === 'night' ? 'moon' : 'sun'} />
      {PHASE_LABEL[phase]}
      {mode === 'auto' && <span className="text-[11px] opacity-70">auto</span>}
    </button>
  );
}

export function TopBar() {
  const c = useCounts();
  const sim = useOffice((s) => s.sim);
  const connection = useOffice((s) => s.connection);
  const chatOpen = useOffice((s) => s.chatOpen);
  const ai = useOffice((s) => s.ai);
  const soundOn = useSound((s) => s.on);
  const volume = useSound((s) => s.volume);
  const firstBlocked = useOffice((s) => Object.values(s.agents).find((a) => a.status === 'blocked')?.id);

  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-[#0b1220] px-4 py-1.5">
      <div className="flex items-center gap-2.5">
        <Icon name="logo" size={22} className="text-accent" />
        <span className="font-display text-xl tracking-[0.08em]">CLAUDE AI OFFICE</span>
      </div>

      {connection !== 'open' && (
        <span role="status" className="rounded-md border border-warning/50 px-2 py-1 font-mono text-[11px] text-warning">
          {connection === 'connecting' ? 'connecting…' : 'server offline · retrying'}
        </span>
      )}

      <nav aria-label="Agent status counters" className="mx-auto flex flex-wrap gap-1.5">
        <Counter n={c.working} label="Working" dot={<span className="size-2 rounded-full bg-accent" />} />
        <Counter n={c.idle} label="Idle" dot={<span className="box-border size-2 rounded-full border-[1.5px] border-muted" />} />
        <button
          className={`${chip} ${c.blocked ? 'border-warning/55 bg-warning/8 text-warning' : 'border-border text-muted'}`}
          disabled={!c.blocked}
          onClick={() => firstBlocked && useOffice.getState().select(firstBlocked)}
          title={c.blocked ? 'Show the blocked agent' : undefined}
        >
          <Icon name="hand" />
          <span className="font-mono tabular-nums">{c.blocked}</span>
          <span>Blocked</span>
        </button>
        <Counter n={c.doneToday} label="Done today" dot={<Icon name="check" className="text-success" strokeWidth={2.5} />} />
      </nav>

      <div className="flex items-center gap-2">
        <button
          onClick={() => toggleSim(!sim)}
          aria-pressed={sim}
          className={`${chip} rounded-full ${sim ? 'border-accent-2/50 bg-accent-2/10 text-[#f0abfc]' : 'border-border text-muted hover:text-text'}`}
        >
          <Icon name={sim ? 'stop' : 'play'} size={12} />
          {sim ? 'Demo running · stop' : 'Run demo'}
        </button>
        <button
          onClick={() => void setAi(!ai.enabled)}
          aria-pressed={ai.enabled}
          title={
            ai.enabled
              ? ai.available === false
                ? 'The claude command was not found on the machine running the server'
                : 'The Office Manager answers in #office and DMs (one claude -p call per question)'
              : 'Turn on the Office Manager (runs claude -p with your Claude Code login)'
          }
          className={`${chip} rounded-full ${ai.enabled ? (ai.available === false ? 'border-warning/50 text-warning' : 'border-accent-2/50 bg-accent-2/10 text-[#f0abfc]') : 'border-border text-muted hover:text-text'}`}
        >
          <Icon name="sparkle" />
          {ai.enabled ? `AI on · ${ai.model[0].toUpperCase()}${ai.model.slice(1)}` : 'AI off'}
        </button>
        <DayNightChip />
        <div className={`${chip} rounded-full ${soundOn ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'}`}>
          <button
            onClick={() => void toggleSound()}
            aria-pressed={soundOn}
            title={soundOn ? 'Turn sound off (M)' : 'Turn on office sound: footsteps, typing, chimes (M)'}
            className="flex items-center gap-2"
          >
            <Icon name={soundOn ? 'volume' : 'mute'} />
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          {soundOn && (
            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => {
                useSound.getState().setVolume(Number(e.target.value) / 100);
                previewVolume();
              }}
              className="h-1 w-16 accent-accent"
            />
          )}
        </div>
        <button
          aria-label={chatOpen ? 'Hide side panel' : 'Show side panel'}
          title="Toggle side panel (C)"
          aria-pressed={chatOpen}
          onClick={() => useOffice.getState().toggleChat()}
          className="grid size-9 place-items-center rounded-md border border-border text-muted hover:text-text"
        >
          <Icon name="panel" size={16} />
        </button>
        <a
          href="?debug"
          aria-label="Debug view"
          title="Debug view"
          className="grid size-9 place-items-center rounded-md border border-border text-muted hover:text-text"
        >
          <Icon name="sliders" size={16} />
        </a>
      </div>
    </header>
  );
}

function Counter({ n, label, dot }: { n: number; label: string; dot: ReactNode }) {
  return (
    <span className={`${chip} border-border`}>
      {dot}
      <span className="font-mono tabular-nums">{n}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}
