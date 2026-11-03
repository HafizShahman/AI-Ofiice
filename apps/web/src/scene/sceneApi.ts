import type { Anchor } from './anchors.ts';
import type { Pt } from './layout.ts';
import type { Waypoint } from './nav.ts';
import type { CameraView, SceneAgent, Spatial } from './OfficeScene.ts';

export type { CameraView, SceneAgent, Spatial };

/**
 * What the React side drives (OfficeView, the sound cues, the ⌘K palette, keyboard shortcuts, the
 * ?helper editor). Both the painted 2D office (OfficeScene) and the 3D room (OfficeScene3D) implement it.
 */
export interface OfficeSceneApi {
  /** DOM elements pinned to a place in the room (the mission board hotspot) */
  anchors: Map<string, Anchor>;
  /** ?helper overlay (2D only) */
  overlay: HTMLElement | null;
  reduceMotion: boolean;
  onViewChange?: (v: CameraView) => void;
  onStep?: (id: string, at: Spatial) => void;
  onArrive?: (id: string, propId: string, at: Spatial) => void;

  setAgents(agents: SceneAgent[]): void;
  resize(w: number, h: number): void;
  setPixelRatioCap(cap: number): void;
  setTour(on: boolean): void;
  fit(jump?: boolean): void;
  zoomBy(factor: number, at?: { x: number; y: number }): void;
  panBy(dx: number, dy: number): void;
  /** 3D only: turn the camera (screen px of drag) */
  orbitBy?(dx: number, dy: number): void;
  focus(id: string, follow?: boolean): void;
  spatial(id: string): Spatial | null;
  isWalking(id: string): boolean | null;
  readonly followingId: string | null;
  setSelected(id: string | null): void;
  hitTest(sx: number, sy: number): string | null;
  flashProp(propId: string, kind: 'fail' | 'ring'): void;
  walkers(): { id: string; pos: Pt; path: Waypoint[] }[];
  roomAt(sx: number, sy: number): Pt;
  readonly zoom: number;
  invalidate(): void;
  dispose(): void;
}
