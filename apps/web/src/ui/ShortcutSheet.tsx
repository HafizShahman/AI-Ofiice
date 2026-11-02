import { useEffect } from 'react';
import { useUi } from './prefs.ts';

const GROUPS: [string, [string, string][]][] = [
  [
    'Navigate',
    [
      ['⌘K', 'Command palette'],
      ['[  ]', 'Previous / next agent'],
      ['Shift F', 'Follow the selected agent'],
      ['+  −  0', 'Zoom in / out / fit the room'],
      ['Esc', 'Close, clear the filter, deselect'],
    ],
  ],
  [
    'Panels',
    [
      ['/', 'Focus the chat composer'],
      ['B', 'Mission board: tasks and reminders'],
      ['C', 'Toggle the side panel'],
      ['F', 'Wallboard mode'],
      ['?', 'This sheet'],
    ],
  ],
  [
    'Filter the roster',
    [
      ['1', 'Arriving'],
      ['2', 'Working'],
      ['3', 'Blocked'],
      ['4', 'Idle'],
      ['5', 'On a break'],
      ['6', 'Charging'],
      ['7', 'Done'],
      ['8', 'Leaving'],
    ],
  ],
  [
    'Scene',
    [
      ['M', 'Sound on / off'],
      ['N', 'Lighting: auto, day, night'],
    ],
  ],
];

/** UI-PLAN §6: the "?" sheet. Esc or a click outside closes it. */
export function ShortcutSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useUi.getState().setShortcuts(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  const close = () => useUi.getState().setShortcuts(false);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Keyboard shortcuts" className="max-h-[80vh] w-full max-w-[640px] overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-[0_24px_64px_rgb(0_0_0/.6)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg tracking-[0.08em]">KEYBOARD SHORTCUTS</h2>
          <button onClick={close} className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted hover:text-text">
            esc
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {GROUPS.map(([title, rows]) => (
            <section key={title}>
              <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{title}</h3>
              <dl className="flex flex-col gap-1">
                {rows.map(([k, what]) => (
                  <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
                    <dd className="text-text/90">{what}</dd>
                    <dt>
                      <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent">{k}</kbd>
                    </dt>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
