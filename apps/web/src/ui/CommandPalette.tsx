import { useEffect, useMemo, useRef, useState } from 'react';
import { sceneRef } from '../office/OfficeView.tsx';
import { useMeeting } from '../office/useMeeting.ts';
import { useDaylight, type Mode } from '../scene/daylight.ts';
import { toggleSound } from '../sound/cues.ts';
import { useSound } from '../sound/engine.ts';
import { sendChat, setAi, setApprovals, toggleSim, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { usePrefs, useUi, type Quality } from './prefs.ts';
import { Avatar } from './util.tsx';
import type { AgentState } from '@ai-office/shared';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  agent?: AgentState;
  run(): void;
}

/** UI-PLAN §4.8: ⌘K. Jump to an agent or channel, flip a setting, run a slash command. */
function useCommands(): Cmd[] {
  const agents = useOffice((s) => s.agents);
  const ai = useOffice((s) => s.ai);
  const sim = useOffice((s) => s.sim);
  const approvalsOn = useOffice((s) => s.approvalsOn);
  const chatOpen = useOffice((s) => s.chatOpen);
  const soundOn = useSound((s) => s.on);
  const reduce = usePrefs((s) => s.reduceMotion);
  const meeting = useMeeting((s) => s.on);

  return useMemo(() => {
    const o = useOffice.getState();
    const slash = (text: string) => () => {
      o.openChannel('office', true);
      void sendChat('office', text);
    };
    const list = Object.values(agents).sort((a, b) => a.startedAt - b.startedAt);
    const cmds: Cmd[] = [];
    for (const a of list) {
      cmds.push({ id: `go:${a.id}`, group: 'Agents', label: `Go to ${a.name}`, hint: a.project, agent: a, run: () => (o.select(a.id), sceneRef.current?.focus(a.id)) });
      cmds.push({ id: `dm:${a.id}`, group: 'Agents', label: `Message ${a.name}`, hint: 'DM', agent: a, run: () => o.openChannel(`dm:${a.id}`, true) });
    }
    cmds.push(
      { id: 'ch:activity', group: 'Channels', label: 'Open #activity', run: () => o.openChannel('activity') },
      { id: 'ch:office', group: 'Channels', label: 'Open #office', hint: 'Office Manager', run: () => o.openChannel('office', true) },
      { id: 'wallboard', group: 'View', label: 'Wallboard mode', hint: 'F', run: () => useUi.getState().setWallboard(true) },
      { id: 'board', group: 'View', label: 'Open the mission board', hint: 'B', run: () => useUi.getState().setBoard('card') },
      { id: 'board-full', group: 'View', label: 'Open the mission board full screen', hint: 'tasks and reminders', run: () => useUi.getState().setBoard('overlay') },
      { id: 'shortcuts', group: 'View', label: 'Keyboard shortcuts', hint: '?', run: () => useUi.getState().setShortcuts(true) },
      { id: 'fit', group: 'View', label: 'Reset camera to the whole room', hint: '0', run: () => sceneRef.current?.fit() },
      { id: 'panel', group: 'View', label: chatOpen ? 'Hide the side panel' : 'Show the side panel', hint: 'C', run: () => o.toggleChat() },
      { id: 'meeting', group: 'View', label: meeting ? 'End the meeting' : 'Call a meeting at the holo-table', run: () => useMeeting.getState().set(!meeting) },
      { id: 'settings', group: 'Settings', label: 'Open settings', run: () => useUi.getState().setSettings(true) },
      { id: 'ai', group: 'Settings', label: ai.enabled ? 'Turn the Office Manager off' : 'Turn the Office Manager on', hint: 'AI', run: () => void setAi(!ai.enabled) },
      { id: 'approvals', group: 'Settings', label: approvalsOn ? 'Stop approving from the office' : 'Approve permission prompts from the office', run: () => void setApprovals(!approvalsOn) },
      { id: 'sim', group: 'Settings', label: sim ? 'Stop the demo' : 'Run the demo', hint: 'sim', run: () => void toggleSim(!sim) },
      { id: 'sound', group: 'Settings', label: soundOn ? 'Turn sound off' : 'Turn sound on', hint: 'M', run: () => void toggleSound() },
      { id: 'motion', group: 'Settings', label: reduce ? 'Allow motion' : 'Reduce motion', run: () => usePrefs.getState().set({ reduceMotion: !reduce }) },
    );
    for (const [m, text] of [['auto', 'Auto (follows the clock)'], ['day', 'Day'], ['night', 'Night']] as [Mode, string][])
      cmds.push({ id: `light:${m}`, group: 'Settings', label: `Lighting: ${text}`, hint: 'N', run: () => useDaylight.getState().setMode(m) });
    for (const q of ['low', 'medium', 'high'] as Quality[])
      cmds.push({ id: `quality:${q}`, group: 'Settings', label: `Resolution: ${q[0].toUpperCase() + q.slice(1)}`, run: () => usePrefs.getState().set({ quality: q }) });
    cmds.push(
      { id: 'cmd:todo', group: 'Commands', label: '/todo', hint: 'the CEO pins a task', run: () => o.openChannel('office', true) },
      { id: 'cmd:remind', group: 'Commands', label: '/remind', hint: 'in 20m, at 15:30, tomorrow 9am', run: () => o.openChannel('office', true) },
      { id: 'cmd:status', group: 'Commands', label: '/status', hint: 'office summary', run: slash('/status') },
      { id: 'cmd:agents', group: 'Commands', label: '/agents', hint: 'who is here', run: slash('/agents') },
      { id: 'cmd:help', group: 'Commands', label: '/help', hint: 'all commands', run: slash('/help') },
    );
    return cmds;
  }, [agents, ai, sim, approvalsOn, chatOpen, soundOn, reduce, meeting]);
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}

function Palette() {
  const cmds = useCommands();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const close = () => useUi.getState().setPalette(false);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return cmds.filter((c) => {
      const hay = `${c.group} ${c.label} ${c.hint ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [cmds, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Cmd | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[14vh]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Command palette" className="flex max-h-[60vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[0_24px_64px_rgb(0_0_0/.6)]">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Icon name="search" size={16} className="text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to an agent, change a setting, run a command…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((i) => Math.min(shown.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
              else if (e.key === 'Enter') run(shown[active]);
              else if (e.key === 'Escape') close();
              else return;
              e.preventDefault();
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!shown.length && <li className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches “{q}”.</li>}
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === active}
              onPointerMove={() => setActive(i)}
              onClick={() => run(c)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[13px] ${i === active ? 'bg-accent/14 text-text' : 'text-text/90'}`}
            >
              {c.agent ? <Avatar a={c.agent} size={20} /> : <span className="w-5" />}
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.hint && <span className="shrink-0 font-mono text-[11px] text-muted">{c.hint}</span>}
              <span className="w-16 shrink-0 text-right font-mono text-[10px] uppercase tracking-wider text-muted/70">{c.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
