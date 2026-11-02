import { ROOM_H, ROOM_W } from './layout.ts';

/**
 * DOM elements pinned to a place in the room (not to a robot), moved by the scene every frame.
 * A box (`w`, `h` set, in room px) scales with the zoom, like the painted art under it; a point
 * keeps its size and sits above its position, like an overhead tag.
 */
export interface Anchor {
  el: HTMLElement;
  rx: number;
  ry: number;
  w?: number;
  h?: number;
}

export const anchorEls = new Map<string, Anchor>();

/**
 * The painted holographic mission board on the back wall (traced by eye on the 2400×1792 art:
 * x 1794–2076, y 438–744). Re-check it if `Assets/room` changes.
 */
export const BOARD_BOX = { x: (1935 / 2400) * ROOM_W, y: (591 / 1792) * ROOM_H, w: (282 / 2400) * ROOM_W, h: (306 / 1792) * ROOM_H };
