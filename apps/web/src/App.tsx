import { useEffect } from 'react';
import { OfficeView, sceneRef } from './office/OfficeView.tsx';
import { DebugView } from './DebugView.tsx';
import { useDaylight } from './scene/daylight.ts';
import { connect, toggleSim, useOffice } from './store.ts';
import { toggleSound, useSoundCues } from './sound/cues.ts';
import { TopBar } from './ui/TopBar.tsx';
import { Roster } from './ui/Roster.tsx';
import { BlockedToast, Inspector } from './ui/Inspector.tsx';
import { SidePanel } from './ui/SidePanel.tsx';
import { EmptyState } from './ui/EmptyState.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { SettingsDrawer } from './ui/SettingsDrawer.tsx';
import { BoardCard, BoardOverlay, ReminderAlerts } from './ui/MissionBoard.tsx';
import { ShortcutSheet } from './ui/ShortcutSheet.tsx';
import { SimRibbon } from './ui/SimRibbon.tsx';
import { Wallboard } from './ui/Wallboard.tsx';
import { useDesktopBadge } from './ui/desktop.ts';
import { useBlockedNotifications } from './ui/notify.ts';
import { initPrefs, useUi } from './ui/prefs.ts';
import { STATUS_KEYS } from './ui/util.tsx';

export function App() {
  return new URLSearchParams(location.search).has('debug') ? <DebugView /> : <Office />;
}

function Office() {
  useEffect(() => connect(), []);
  useEffect(() => initPrefs(), []);
  useSoundCues();
  useBlockedNotifications();
  useDesktopBadge();
  useKeyboard();
  useSimLink();
  const chatOpen = useOffice((s) => s.chatOpen);
  const wallboard = useUi((s) => s.wallboard);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {!wallboard && <TopBar />}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <section aria-label="Office" className="relative min-h-0 flex-1">
            <OfficeView>
              <BlockedToast />
              <SimRibbon />
              {!wallboard && <BoardCard />}
              {wallboard ? (
                <Wallboard />
              ) : (
                <>
                  <Inspector />
                  <EmptyState />
                </>
              )}
            </OfficeView>
          </section>
          {!wallboard && <Roster />}
        </main>
        {chatOpen && !wallboard && <SidePanel />}
      </div>
      {!wallboard && <SettingsDrawer />}
      {!wallboard && <CommandPalette />}
      {!wallboard && <ShortcutSheet />}
      {!wallboard && <BoardOverlay />}
      <ReminderAlerts />
    </div>
  );
}

/** `?sim` deep link: start the demo once, when the first snapshot shows it is not running. */
function useSimLink() {
  const epoch = useOffice((s) => s.epoch);
  useEffect(() => {
    if (epoch !== 1 || !new URLSearchParams(location.search).has('sim')) return;
    if (!useOffice.getState().sim) void toggleSim(true);
  }, [epoch]);
}

/** UI-PLAN §6: ⌘K, Esc, [ ], F wallboard, Shift+F, C, +/−, 0, 1–8 status filter, ? sheet; plus M for sound, N for day/night and B for the mission board. */
function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!ui.wallboard) ui.setPalette(!ui.paletteOpen);
        return e.preventDefault();
      }
      // Esc closes the drawer, then leaves wallboard mode (the palette handles its own Esc)
      if (e.key === 'Escape' && (ui.settingsOpen || ui.wallboard) && !ui.shortcutsOpen) {
        if (ui.settingsOpen) ui.setSettings(false);
        else ui.setWallboard(false);
        return e.preventDefault();
      }
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || ui.paletteOpen || ui.shortcutsOpen || ui.board === 'overlay') return;
      const s = useOffice.getState();
      const ids = Object.values(s.agents)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((a) => a.id);
      if (e.key === 'Escape') {
        if (ui.board !== 'closed') ui.setBoard('closed');
        else if (ui.filter) ui.setFilter(null);
        else s.select(null);
      } else if (e.key === '?') ui.setShortcuts(true);
      else if (/^[1-8]$/.test(e.key)) ui.setFilter(STATUS_KEYS[Number(e.key) - 1]);
      else if (e.key === '[' || e.key === ']') {
        if (!ids.length) return;
        const i = s.selected ? ids.indexOf(s.selected) : -1;
        s.select(ids[(i + (e.key === ']' ? 1 : -1) + ids.length) % ids.length]);
      } else if (e.key === 'F' && e.shiftKey) s.selected && s.setFollowing(!s.following);
      else if (e.key === 'b' || e.key === 'B') ui.setBoard(ui.board === 'closed' ? 'card' : 'closed');
      else if (e.key === 'c' || e.key === 'C') s.toggleChat();
      else if (e.key === 'm' || e.key === 'M') void toggleSound();
      else if (e.key === 'n' || e.key === 'N') useDaylight.getState().cycle();
      else if (e.key === 'f') ui.setWallboard(!ui.wallboard);
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
