import * as THREE from 'three';
import { lerp, mix, type Light, type RGB } from './daylight.ts';

/**
 * Sunlight through the window wall, laid on the 3D floor. Each of the five panes throws a soft
 * patch of light across the floor: long and low when the sun is low, short and high at noon, and it
 * swings across the room through the day (the 3D counterpart of the painted office's pane beams).
 * Additive and depth-tested, so it lightens the floor and whatever stands in it, and goes under the deck.
 *
 * Pane geometry matches Assets/blender/build_room.py (Room_WindowGlass): x = 0, d = 1.4 + k·1.76 + 0.11 … +1.65,
 * z = 0.4 … 4.95. Three.js space: X = x along the back wall, Z = d away from it, Y up.
 */

const PANES: [number, number][] = [0, 1, 2, 3, 4].map((k) => [1.4 + k * 1.76 + 0.11, 1.4 + (k + 1) * 1.76 - 0.11]);
const Z_BOTTOM = 0.4;
const Z_TOP = 4.95;
const FLOOR_Y = 0.07; // just above the floor (floorZ 0.05)
const MAX_REACH = 9; // m: a patch never runs past the back of the room
const MIN_ELEV = 0.08; // below this the sun is too low to light the floor
const SWING = 0.9; // how far the patches swing sideways between sunrise and sunset (m per m of reach)

/** a soft-edged streak: bright near the glass, fading with distance, feathered at the sides */
function patchTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 128); // canvas top = far end of the patch
  v.addColorStop(0, 'rgba(255,255,255,0)');
  v.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  v.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.18, 'rgba(255,255,255,1)');
  h.addColorStop(0.82, 'rgba(255,255,255,1)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SunPatches {
  private meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private tex = patchTexture();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < PANES.length; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** Re-lay the patches for this light. `day` is the eased daylight (0 night … 1 day). */
  update(l: Light, day: number): void {
    const on = day > 0.04 && l.elev > MIN_ELEV;
    if (!on) {
      for (const m of this.meshes) m.visible = false;
      return;
    }
    const elev = Math.min(0.98, l.elev);
    const tanAlt = elev / Math.sqrt(1 - elev * elev); // horizontal metres per metre of height
    // the sun's way across the sky: its ground track swings from one side of the window to the other
    const side = (0.5 - l.sunP) * SWING;
    const brightness = day * (0.3 + 0.35 * Math.sqrt(elev));
    const col: RGB = mix([1, 0.92, 0.75], [1, 0.6, 0.32], l.warm * 0.8);

    for (let i = 0; i < PANES.length; i++) {
      const [d0, d1] = PANES[i];
      const mesh = this.meshes[i];
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      // corners: near the glass (v = 0) and far across the floor (v = 1); u runs along the pane
      const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      corners.forEach(([u, v], k) => {
        const z = lerp(Z_BOTTOM, Z_TOP, v);
        const x = Math.min(MAX_REACH, z / tanAlt);
        const d = lerp(d0, d1, u) + x * side;
        pos.setXYZ(k, x, FLOOR_Y, d);
      });
      pos.needsUpdate = true;
      mesh.material.color.setRGB(col[0] * brightness, col[1] * brightness, col[2] * brightness, THREE.SRGBColorSpace);
      mesh.visible = true;
    }
  }
}
