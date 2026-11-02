import { useEffect } from 'react';
import { OfficeView, sceneRef } from './office/OfficeView.tsx';
import { DebugView } from './DebugView.tsx';
import { useDaylight } from './scene/daylight.ts';
import { connect, useOffice } from './store.ts';
import { toggleSound, useSoundCues } from './sound/cues.ts';
import { TopBar } from './ui/TopBar.tsx';
import { Roster } from './ui/Roster.tsx';
import { BlockedToast, Inspector } from './ui/Inspector.tsx';
import { SidePanel } from './ui/SidePanel.tsx';
import { EmptyState } from './ui/EmptyState.tsx';

export function App() {
  return new URLSearchParams(location.search).has('debug') ? <DebugView /> : <Office />;
}

function Office() {
  useEffect(() => connect(), []);
  useSoundCues();
  useKeyboard();
  const chatOpen = useOffice((s) => s.chatOpen);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <section aria-label="Office" className="relative min-h-0 flex-1">
            <OfficeView>
              <BlockedToast />
              <Inspector />
              <EmptyState />
            </OfficeView>
          </section>
          <Roster />
        </main>
        {chatOpen && <SidePanel />}
      </div>
    </div>
  );
}

/** UI-PLAN §6: Esc, [ ], Shift+F, C, +/−, 0; plus M for sound and N for day/night. */
function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useOffice.getState();
      const ids = Object.values(s.agents)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((a) => a.id);
      if (e.key === 'Escape') s.select(null);
      else if (e.key === '[' || e.key === ']') {
        if (!ids.length) return;
        const i = s.selected ? ids.indexOf(s.selected) : -1;
        s.select(ids[(i + (e.key === ']' ? 1 : -1) + ids.length) % ids.length]);
      } else if (e.key === 'F' && e.shiftKey) s.selected && s.setFollowing(!s.following);
      else if (e.key === 'c' || e.key === 'C') s.toggleChat();
      else if (e.key === 'm' || e.key === 'M') void toggleSound();
      else if (e.key === 'n' || e.key === 'N') useDaylight.getState().cycle();
      else if (e.key === '/') s.openChannel(s.channel === 'activity' ? 'office' : s.channel, true);
      else if (e.key === '+' || e.key === '=') sceneRef.current?.zoomBy(1.25);
      else if (e.key === '-') sceneRef.current?.zoomBy(0.8);
      else if (e.key === '0') sceneRef.current?.fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
