import { useEffect } from 'react';
import { useOffice } from '../store.ts';

/** Inside the desktop app (apps/desktop, Tauri) the page can call a few Rust commands; in a browser this does nothing. */
type Tauri = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
const tauri = () => (window as unknown as { __TAURI_INTERNALS__?: Tauri }).__TAURI_INTERNALS__;

/** Show the number of blocked agents on the desktop app's tray icon. */
export function useDesktopBadge(): void {
  useEffect(() => {
    if (!tauri()) return;
    let last = -1;
    const push = (s: ReturnType<typeof useOffice.getState>) => {
      let n = 0;
      for (const a of Object.values(s.agents)) if (a.status === 'blocked') n++;
      if (n === last) return;
      last = n;
      void tauri()?.invoke('set_blocked', { count: n }).catch(() => {});
    };
    push(useOffice.getState());
    return useOffice.subscribe(push);
  }, []);
}
