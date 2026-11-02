import { create } from 'zustand';

/**
 * The CEO's meeting at the holo-table: while it is on, the CEO stays at the table and every other
 * robot (except agents waiting on you) walks to a seat of the `kind: "meeting"` prop in props.json.
 * Purely visual: the server's agent states are untouched. It ends on its own after MEETING_MAX_S.
 */
export const MEETING_MAX_S = 90;

export const useMeeting = create<{ on: boolean; set(on: boolean): void }>((set) => ({
  on: false,
  set: (on) => set({ on }),
}));
