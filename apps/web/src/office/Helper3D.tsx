import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { OfficeScene3D } from '../scene/OfficeScene3D.ts';
import base from '../scene/room3d.json';
import overrides from '../scene/room3d.overrides.json';
import { sceneRef } from './OfficeView.tsx';

/**
 * ?helper in the 3D room — drag each spot (where a robot stands) and its facing point across the
 * floor or the deck. A point keeps its height; arrows nudge it (Shift = ×10). Save writes only the
 * points that differ from room3d.json to room3d.overrides.json through the Vite dev server (the
 * built app downloads the file instead). Blender rebuilds leave the overrides alone.
 */

type Pts = number[]; // plan [x, d, height] in metres
interface Spot {
  id: string;
  pos: Pts;
  face: Pts | null;
}
type Sel = { id: string; which: 'pos' | 'face' };

const BASE = base.spots as Record<string, { pos: Pts; face: Pts | null }>;
const STEP = 0.05;
const HANDLE = 7; // px on screen

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const same = (a: Pts | null, b: Pts | null) => (!a || !b ? a === b : a.every((v, i) => Math.abs(v - b[i]) < 1e-3));
const changed = (sp: Spot) => !same(sp.pos, BASE[sp.id].pos) || !same(sp.face, BASE[sp.id].face);
const scene = () => sceneRef.current as OfficeScene3D | null;
const fmt = (p: Pts) => `x ${p[0].toFixed(2)} · d ${p[1].toFixed(2)} · h ${p[2].toFixed(2)} m`;

export function Helper3D() {
  const overlay = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [drag, setDrag] = useState<Sel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [, setFrame] = useState(0);

  // the scene mounts after this component: take the spots once it exists (a timer, since a
  // background tab doesn't run rAF), then redraw every frame so the handles follow the camera
  useEffect(() => {
    const load = setInterval(() => {
      const sc = scene();
      if (sc && !loaded.current) {
        loaded.current = true;
        setSpots(sc.spotPoints());
        clearInterval(load);
      }
    }, 100);
    let raf = 0;
    const tick = () => {
      setFrame((f) => f + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      clearInterval(load);
      cancelAnimationFrame(raf);
    };
  }, []);

  const find = (s: Sel) => spots?.find((sp) => sp.id === s.id) ?? null;

  /** Set one point; the height stays where it was. */
  const put = (s: Sel, to: Pts, height?: number) => {
    const sp = find(s);
    const cur = sp?.[s.which];
    if (!sp || !cur) return;
    const next = [round3(to[0]), round3(to[1]), round3(height ?? cur[2])];
    scene()?.setSpotPoint(sp.id, s.which, next);
    setSpots(spots!.map((x) => (x.id === sp.id ? { ...x, [s.which]: next } : x)));
    setDirty(true);
  };

  const pctAt = (e: { clientX: number; clientY: number }): Pts => {
    const host = overlay.current!.parentElement!.getBoundingClientRect();
    return [e.clientX - host.left, e.clientY - host.top];
  };

  const startDrag = (s: Sel) => (e: RPointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setSel(s);
    setDrag(s);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag || !scene()) return;
    const cur = find(drag)?.[drag.which];
    if (!cur) return;
    const [sx, sy] = pctAt(e);
    const [x, d] = scene()!.planAt(sx, sy, cur[2]);
    put(drag, [x, d]);
  };
  const onUp = () => setDrag(null);

  // keyboard: nudge the selected point
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel || (e.target as HTMLElement).closest('input')) return;
      const step = e.shiftKey ? STEP * 10 : STEP;
      const moves: Record<string, Pts> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = moves[e.key];
      if (!m) return;
      const cur = find(sel)?.[sel.which];
      if (!cur) return;
      put(sel, [cur[0] + m[0], cur[1] + m[1]]);
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const reset = (s: Sel) => {
    const v = BASE[s.id][s.which];
    if (v) put(s, v, v[2]);
  };

  const save = async () => {
    const out: Record<string, { pos: Pts; face: Pts | null }> = {};
    for (const sp of spots ?? []) if (changed(sp)) out[sp.id] = { pos: sp.pos, face: sp.face };
    const text = JSON.stringify({ _note: overrides._note, spots: out }, null, 1) + '\n';
    try {
      const r = await fetch('/__helper/room3d', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      if (!r.ok) throw new Error(String(r.status));
      setStatus(`Saved ${Object.keys(out).length} moved point(s) to room3d.overrides.json. Reload the page to see them.`);
      setDirty(false);
    } catch {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'room3d.overrides.json';
      a.click();
      setStatus('No dev server to save through: downloaded room3d.overrides.json instead (copy it to apps/web/src/scene/).');
    }
  };

  const sc = scene();
  const r = HANDLE;
  const selSpot = sel && find(sel);
  const selPts = selSpot && sel ? selSpot[sel.which] : null;

  const handle = (s: Sel, p: Pts, color: string, key: string) => {
    if (!sc) return null;
    const [x, y] = sc.projectPlan(p);
    const active = sel?.id === s.id && sel.which === s.which;
    return (
      <circle
        key={key}
        cx={x}
        cy={y}
        r={r}
        fill={active ? '#fff' : color}
        stroke="#04131a"
        strokeWidth={1.5}
        style={{ cursor: 'move', pointerEvents: 'auto' }}
        onPointerDown={startDrag(s)}
      />
    );
  };

  return (
    <>
      <div
        ref={overlay}
        data-ui
        className="pointer-events-none absolute inset-0"
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {sc &&
            spots?.map((sp) => {
              const [x, y] = sc.projectPlan(sp.pos);
              return (
                <g key={sp.id}>
                  {sp.face && (() => {
                    const [fx, fy] = sc.projectPlan(sp.face);
                    return <line x1={x} y1={y} x2={fx} y2={fy} stroke="#A78BFA" strokeWidth={1.5} strokeDasharray="4 3" style={{ pointerEvents: 'none' }} />;
                  })()}
                  {changed(sp) && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="#FBBF24" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />}
                  {handle({ id: sp.id, which: 'pos' }, sp.pos, '#22D3EE', `s-${sp.id}`)}
                  {sp.face && handle({ id: sp.id, which: 'face' }, sp.face, '#A78BFA', `f-${sp.id}`)}
                  <text x={x + r * 1.4} y={y + r * 0.5} fontSize={11} fill="#E6EDF7" stroke="#04131a" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }}>
                    {sp.id}
                  </text>
                </g>
              );
            })}
        </svg>
      </div>

      {/* panel */}
      <div data-ui className="absolute bottom-4 left-4 w-[300px] rounded-[10px] border border-border bg-surface/97 p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/.45)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] tracking-[0.1em] text-accent">LAYOUT HELPER · 3D</span>
          <a href={location.pathname} className="text-muted hover:text-text">
            exit
          </a>
        </div>
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full" style={{ background: '#22D3EE' }} /> spot
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full" style={{ background: '#A78BFA' }} /> facing
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full border border-[#FBBF24]" /> moved
          </span>
        </div>
        {!spots && <p className="text-muted">Loading the room…</p>}
        {sel && selSpot && selPts ? (
          <div className="rounded-md border border-border p-2">
            <div className="font-medium">
              {sel.id} · {sel.which === 'pos' ? 'spot' : 'facing point'}
            </div>
            <div className="font-mono text-muted">{fmt(selPts)}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {changed(selSpot) && (
                <Btn onClick={() => reset(sel)}>reset to Blender</Btn>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted">Click a handle to select it. Drag across the floor or deck (height is kept), arrows to nudge (Shift ×10).</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-muted">{spots ? `${spots.filter(changed).length} moved` : ''}</span>
          <button onClick={save} className="ml-auto h-7 rounded-md bg-accent px-3 font-medium text-[#04131a] disabled:opacity-50" disabled={!dirty}>
            Save
          </button>
        </div>
        {status && <p className="mt-2 text-muted">{status}</p>}
      </div>
    </>
  );
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="h-7 rounded-md border border-border px-2 hover:bg-surface-2">
      {children}
    </button>
  );
}
