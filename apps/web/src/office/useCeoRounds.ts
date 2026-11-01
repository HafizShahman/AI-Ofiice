import { useEffect, useState } from 'react';
import type { Activity } from '@ai-office/shared';
import { PROPS, spotIds } from '../scene/layout.ts';

/**
 * The CEO's home is the holo-table. Every so often they leave it, visit two or three of the
 * other `kind: "ceo"` props in props.json (the stops, desk included; drag them in ?helper), then walk back.
 * Only the destination changes here: the scene walks the robot there and plays the pose for `activity`.
 */

export interface CeoState {
  spot: string;
  activity: Activity;
  /** the line under the CEO's overhead tag */
  line: string;
}

const HOME = 'ceo-holo';
const TICK_MS = 100; // a short hop (servers → desk is 0.2 s) must not fall between two ticks
const HOME_DWELL_S: [number, number] = [10, 18];
const STOP_DWELL_S: [number, number] = [6, 12];

/** What the CEO does at each stop; a stop not listed here (e.g. one added in the helper) just watches. */
const AT: Record<string, { activity: Activity; line: string }> = {
  'ceo-desk': { activity: 'idle', line: 'At the desk' },
  'ceo-servers': { activity: 'researching', line: 'Checking the servers' },
  'ceo-holo': { activity: 'thinking', line: 'At the holo-table' },
  'ceo-whiteboard': { activity: 'planning', line: 'At the whiteboard' },
  'ceo-coffee': { activity: 'coffee', line: 'Coffee break' },
  'ceo-comms': { activity: 'browsing', line: 'Checking comms' },
  'ceo-desks': { activity: 'idle', line: 'Checking on the team' },
};

const WATCHING = { activity: 'idle', line: 'Watching' } as const;
const rand = ([a, b]: [number, number]) => a + Math.random() * (b - a);

/** The server-format spot id of a stop, or null if the prop is gone or has no spot (edited in the helper). */
function spotOf(id: string): string | null {
  const p = PROPS.find((x) => x.id === id);
  return p?.spots?.length ? spotIds(p)[0] : null;
}

const stopsAway = (from: string, visited: Set<string>) =>
  PROPS.filter((p) => p.kind === 'ceo' && p.id !== HOME && p.id !== from && !visited.has(p.id) && p.spots?.length);

/**
 * @param isWalking whether the CEO's robot is mid-walk (null = not in the scene yet). Dwell time
 *   counts from arrival, so a long walk across the office doesn't eat the visit. Must be a stable
 *   function: a new one each render would restart the rounds.
 */
export function useCeoRounds(isWalking: () => boolean | null): CeoState {
  const [state, setState] = useState<CeoState>({ spot: HOME, ...(AT[HOME] ?? WATCHING) });

  useEffect(() => {
    let at = HOME;
    let left = 0; // stops left on this round before heading home
    const visited = new Set<string>(); // this round's stops: no repeats
    let travelling = false;
    let moved = false; // seen walking since leaving
    let since = performance.now(); // when the CEO last stopped walking (wall clock: a stalled tick doesn't stretch the dwell)
    let dwell = rand(HOME_DWELL_S);

    const timer = window.setInterval(() => {
      const now = performance.now();
      const walking = document.hidden ? null : isWalking(); // the scene doesn't move robots while the tab is hidden
      if (walking === null) {
        since = now;
        return;
      }
      if (walking) {
        moved = true;
        since = now;
        return;
      }
      const still = (now - since) / 1000;

      if (travelling) {
        // arrived (or the walk never started: give it a moment, then carry on from here)
        if (!moved && still < 3) return;
        travelling = false;
        since = now;
        const spot = spotOf(at);
        if (!spot) {
          at = HOME; // the stop was removed mid-walk: pick the next one straight away
          dwell = 0;
          return;
        }
        setState({ spot, ...(AT[at] ?? WATCHING) });
        return;
      }
      if (still < dwell) return;

      // time to move: a few stops, then back to the desk
      if (at === HOME) {
        visited.clear();
        left = 2 + Math.floor(Math.random() * 2);
      }
      const options = left > 0 ? stopsAway(at, visited) : [];
      const next = options.length ? options[Math.floor(Math.random() * options.length)].id : HOME;
      const spot = spotOf(next);
      if (next === at || !spot) {
        since = now; // nowhere else to go
        return;
      }
      if (next !== HOME) {
        left--;
        visited.add(next);
      }
      at = next;
      travelling = true;
      moved = false;
      since = now;
      dwell = rand(next === HOME ? HOME_DWELL_S : STOP_DWELL_S);
      setState({ spot, activity: 'idle', line: 'Making rounds' });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [isWalking]);

  return state;
}
