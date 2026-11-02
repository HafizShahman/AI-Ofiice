import { useEffect } from 'react';
import type { AgentState } from '@ai-office/shared';
import { useOffice } from '../store.ts';
import { usePrefs } from './prefs.ts';

/**
 * Browser notification when an agent becomes blocked (a permission prompt or a question) while this
 * tab is hidden: that is the moment you'd otherwise miss. Opt-in in Settings → Notifications. The text
 * names the agent and the tool only; the redacted command or path stays in the office.
 */
export function useBlockedNotifications(): void {
  useEffect(() => {
    let status = new Map<string, AgentState['status']>();
    let epoch = useOffice.getState().epoch;
    const open = new Map<string, Notification>();

    const close = (id: string) => {
      open.get(id)?.close();
      open.delete(id);
    };

    return useOffice.subscribe((s) => {
      const resync = s.epoch !== epoch; // a snapshot is history, not news
      epoch = s.epoch;
      const next = new Map<string, AgentState['status']>();
      for (const a of Object.values(s.agents)) {
        next.set(a.id, a.status);
        if (a.status !== 'blocked') close(a.id);
        else if (!resync && status.get(a.id) !== 'blocked') notify(a, open);
      }
      for (const id of open.keys()) if (!next.has(id)) close(id);
      status = next;
    });
  }, []);
}

function notify(a: AgentState, open: Map<string, Notification>): void {
  if (!usePrefs.getState().notify || !document.hidden) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const question = a.tool === 'AskUserQuestion';
  try {
    const n = new Notification(`${a.name} ${question ? 'has a question' : 'needs permission'}`, {
      body: question ? 'Answer it in the office or in that terminal.' : `${a.tool ?? 'A tool'} is waiting for you. Allow or deny it in the office or in that terminal.`,
      tag: `ai-office-${a.id}`,
      silent: true, // the office has its own alert sound
    });
    n.onclick = () => {
      window.focus();
      useOffice.getState().select(a.id);
      n.close();
    };
    open.set(a.id, n);
  } catch {
    /* some browsers only allow notifications from a service worker: nothing to do */
  }
}
