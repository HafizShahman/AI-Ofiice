import { useEffect } from 'react';
import type { AgentState, ChatMessage, OfficeEvent } from '@ai-office/shared';
import type { OfficeSceneApi } from '../scene/sceneApi.ts';
import { PROPS, statusGroup } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { initSound, ready, setBusy, throttle, useSound } from './engine.ts';
import * as v from './voices.ts';

/**
 * Maps what happens in the office to sounds. Status changes and events come from the store (so they
 * play whether or not the scene is on screen); footsteps and prop sounds come from the scene, which
 * knows when a robot's foot lands and where it stops.
 */

/** The mounted scene (see bindScene): it knows where each robot is, for panning. */
let scene: OfficeSceneApi | null = null;
const FLAT: v.Fx = {};
const at = (id: string): v.Fx => scene?.spatial(id) ?? FLAT;

/** Play `fn` if sound is on and the cue isn't throttled. Essential cues also play from a background tab. */
function cue(key: string, ms: number, essential: boolean, fn: () => void): void {
  if (ready(essential) && throttle(key, ms)) fn();
}

function agentCues(prev: Record<string, AgentState>, next: Record<string, AgentState>): void {
  for (const a of Object.values(next)) {
    const was = prev[a.id];
    if (!was) {
      if (a.status === 'arriving') cue('door', 250, true, () => v.door(true));
    } else if (was.status !== a.status) {
      if (a.status === 'blocked') cue('alert', 1500, true, v.alert);
      else if (a.status === 'done') cue('done', 300, true, v.done);
      else if (a.status === 'leaving') cue('door', 250, true, () => v.door(false));
      else if (a.status === 'charging') cue('powerdown', 1000, false, v.powerDown);
    }
  }
}

function eventCue(e: OfficeEvent): void {
  switch (e.kind) {
    case 'tool_start':
      cue('tool', 70, false, () => v.tool(e.tool, at(e.agentId)));
      break;
    case 'tool_fail':
      scene?.flashProp('printer', 'fail');
      cue('fail', 300, true, v.fail);
      break;
    case 'task_done':
      scene?.flashProp('bell', 'ring');
      cue('ping', 300, true, v.ping);
      break;
    case 'prompt':
      cue('prompt', 300, false, v.prompt);
      break;
  }
}

/** Only live messages from the manager or an agent: history loads, clears, your own lines and system lines stay quiet. */
function chatCues(prev: Record<string, ChatMessage[]>, next: Record<string, ChatMessage[]>): void {
  for (const [ch, list] of Object.entries(next)) {
    const before = prev[ch];
    const m = list[list.length - 1];
    if (!before || !m || list.length <= before.length || m.id === before[before.length - 1]?.id) continue;
    if ((m.author === 'manager' || m.author === 'agent') && Date.now() - m.ts < 15_000) cue('pop', 400, false, v.pop);
  }
}

const lastId = (events: OfficeEvent[]) => events[events.length - 1]?.id;

function startCues(): () => void {
  let seen = lastId(useOffice.getState().events);
  const busy = (agents: Record<string, AgentState>) => setBusy(Object.values(agents).filter((a) => statusGroup(a) === 'working').length);
  busy(useOffice.getState().agents);

  const unsub = useOffice.subscribe((s, p) => {
    if (s.epoch !== p.epoch) {
      // a (re)connect hands over the whole state: that is history, not news
      seen = lastId(s.events);
      busy(s.agents);
      return;
    }
    if (s.agents !== p.agents) {
      agentCues(p.agents, s.agents);
      busy(s.agents);
    }
    if (s.events !== p.events) {
      const i = seen ? s.events.findIndex((e) => e.id === seen) : -1;
      const fresh = seen ? (i < 0 ? [] : s.events.slice(i + 1)) : s.events;
      seen = lastId(s.events);
      fresh.forEach(eventCue);
    }
    if (s.chat !== p.chat) chatCues(p.chat, s.chat);
    for (const id in s.approvals) if (!p.approvals[id]) cue('alert', 1500, true, v.alert);
    // a reminder that has just come due (a snapshot is history: it re-syncs silently, and the banner still shows)
    if (s.board !== p.board && s.epoch === p.epoch) {
      const was = new Set(p.board.filter((i) => i.state === 'alerting').map((i) => i.id));
      if (s.board.some((i) => i.state === 'alerting' && !was.has(i.id))) cue('reminder', 1000, true, v.reminder);
    }
  });
  return unsub;
}

/** Footfalls and prop sounds come from the scene. Returns the unbind. */
export function bindSceneSound(s: OfficeSceneApi): () => void {
  scene = s;
  s.onStep = (_id, fx) => cue('step', 45, false, () => v.step(fx));
  s.onArrive = (_id, propId, fx) => {
    const voice = v.AT_PROP[propId];
    // throttled per kind, so the CEO's coffee and an agent's coffee don't hiss over each other
    if (voice) cue(`prop:${PROPS.find((p) => p.id === propId)?.kind ?? propId}`, 400, false, () => voice(fx));
  };
  return () => {
    s.onStep = s.onArrive = undefined;
    if (scene === s) scene = null;
  };
}

/** Start the sound layer: persistence and unlock, plus the store-driven cues. */
export function useSoundCues(): void {
  useEffect(() => {
    const stopInit = initSound();
    const stopCues = startCues();
    return () => {
      stopCues();
      stopInit();
    };
  }, []);
}

/** The toggle (top bar, M key): switching on plays a short chime so you know it works. */
export async function toggleSound(): Promise<void> {
  const s = useSound.getState();
  if (s.on) return void s.setOn(false);
  await s.setOn(true);
  if (ready(true)) v.hello();
}

/** Feedback while dragging the volume slider. */
export function previewVolume(): void {
  cue('preview', 150, true, v.hello);
}

/** Repeat the reminder chime while one is still unanswered. */
export function playReminder(): void {
  cue('reminder', 1000, true, v.reminder);
}
