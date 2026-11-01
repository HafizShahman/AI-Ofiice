import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { getLayout, px, ROOM_H, ROOM_W, setLayout, spotIds, type LayoutData, type Pt } from '../scene/layout.ts';
import { navGrids, obstacles, type Waypoint } from '../scene/nav.ts';
import { round1, serializeLayout } from '../scene/serialize.ts';
import { sceneRef } from './OfficeView.tsx';

/**
 * ?helper — layout editor drawn over the room. Drag spots, sprite feet (the desk's spot moves
 * with it), facing points, walkable-area and obstacle corners, and the stairs. Arrow keys nudge
 * the selection (Shift = ×10). Save writes apps/web/src/scene/props.json through the Vite dev
 * server; on the built app it downloads the file instead.
 */

type Sel =
  | { t: 'spot'; p: number; i: number }
  | { t: 'foot'; p: number; i: number } // i = -1 → prop.foot, else sprites[i]
  | { t: 'face'; p: number }
  | { t: 'area'; a: number; i: number }
  | { t: 'block'; b: number; i: number }
  | { t: 'stairs'; i: 0 | 1 };

const clone = (d: LayoutData): LayoutData => JSON.parse(JSON.stringify(d));
const toPct = (p: Pt): Pt => [round1((p[0] / ROOM_W) * 100), round1((p[1] / ROOM_H) * 100)];

/** Read / write the point a selection refers to (in %). */
function pointOf(d: LayoutData, s: Sel): Pt | null {
  switch (s.t) {
    case 'spot':
      return d.props[s.p]?.spots?.[s.i] ?? null;
    case 'foot':
      return (s.i < 0 ? d.props[s.p]?.foot : d.props[s.p]?.sprites?.[s.i]?.foot) ?? null;
    case 'face':
      return d.props[s.p]?.face ?? null;
    case 'area':
      return d.nav.areas[s.a]?.poly[s.i] ?? null;
    case 'block':
      return d.nav.blocks[s.b]?.poly[s.i] ?? null;
    case 'stairs':
      return d.nav.stairs[s.i];
  }
}

function movePoint(d: LayoutData, s: Sel, to: Pt): void {
  const from = pointOf(d, s);
  if (!from) return;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  from[0] = round1(to[0]);
  from[1] = round1(to[1]);
  // a single-sprite prop carries its spots and facing point along
  if (s.t === 'foot' && s.i < 0) {
    const p = d.props[s.p];
    for (const sp of p.spots ?? []) {
      sp[0] = round1(sp[0] + dx);
      sp[1] = round1(sp[1] + dy);
    }
    if (p.face) p.face = [round1(p.face[0] + dx), round1(p.face[1] + dy)];
  }
}

function label(d: LayoutData, s: Sel): string {
  switch (s.t) {
    case 'spot':
      return `spot ${spotIds(d.props[s.p])[s.i] ?? ''}`;
    case 'foot':
      return `${d.props[s.p].id}${s.i >= 0 ? ` sprite ${s.i + 1}` : ''} (foot)`;
    case 'face':
      return `${d.props[s.p].id} facing point`;
    case 'area':
      return `${d.nav.areas[s.a].level} area · corner ${s.i + 1}`;
    case 'block':
      return `${d.nav.blocks[s.b].id ?? 'block'} · corner ${s.i + 1}`;
    case 'stairs':
      return s.i === 0 ? 'stairs bottom (floor)' : 'stairs top (deck)';
  }
}

export function Helper() {
  const overlay = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<LayoutData>(() => clone(getLayout()));
  const [sel, setSel] = useState<Sel | null>(null);
  const [drag, setDrag] = useState<Sel | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [walkers, setWalkers] = useState<{ id: string; pos: Pt; path: Waypoint[] }[]>([]);
  const [show, setShow] = useState({ grid: true, blocks: true, paths: true });
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  // keep the overlay glued to the camera; poll zoom + robot paths a few times a second
  useEffect(() => {
    // the scene is created in the parent's effect, which runs after this one: attach on the first tick
    const t = setInterval(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      if (scene.overlay !== overlay.current) {
        scene.overlay = overlay.current;
        scene.invalidate();
      }
      setZoom(scene.zoom);
      setWalkers(scene.walkers().map((w) => ({ ...w, path: [...w.path] })));
    }, 200);
    return () => {
      clearInterval(t);
      if (sceneRef.current) sceneRef.current.overlay = null;
    };
  }, []);

  const commit = (d: LayoutData) => {
    setDraft(d);
    setLayout(clone(d));
    setDirty(true);
  };

  // walkable grid as one image (rebuilt when the committed layout changes)
  const gridUrl = useMemo(() => {
    void draft;
    if (!show.grid) return '';
    const g = navGrids();
    const c = document.createElement('canvas');
    c.width = g.floor.cols;
    c.height = g.floor.rows;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < g.floor.open.length; i++) {
      const deck = g.deck.open[i];
      const floor = g.floor.open[i];
      if (!deck && !floor) continue;
      img.data.set(deck ? [96, 165, 250, 70] : [52, 211, 153, 60], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }, [draft, show.grid]);

  const blocks = useMemo(() => {
    void draft;
    return show.blocks ? obstacles() : [];
  }, [draft, show.blocks]);

  // pointer → % of the room
  const pctAt = (e: { clientX: number; clientY: number }): Pt => {
    const host = overlay.current!.parentElement!.getBoundingClientRect();
    return toPct(sceneRef.current!.roomAt(e.clientX - host.left, e.clientY - host.top));
  };

  const startDrag = (s: Sel) => (e: RPointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setSel(s);
    setDrag(s);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const d = clone(draft);
    movePoint(d, drag, pctAt(e));
    setDraft(d); // live handle; the scene + grid update on release
  };
  const onUp = () => {
    if (drag) commit(draft);
    setDrag(null);
  };

  // keyboard: nudge / delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel || (e.target as HTMLElement).closest('input')) return;
      const step = e.shiftKey ? 1 : 0.1;
      const d = clone(draft);
      const p = pointOf(d, sel);
      if (!p) return;
      const moves: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        movePoint(d, sel, [p[0] + moves[e.key][0], p[1] + moves[e.key][1]]);
        commit(d);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!removeSel(d, sel)) return;
        setSel(null);
        commit(d);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const save = async () => {
    const text = serializeLayout(draft);
    try {
      const r = await fetch('/__helper/props', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      if (!r.ok) throw new Error(String(r.status));
      setStatus('Saved props.json. Restart the server if you added or removed spots.');
      setDirty(false);
    } catch {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'props.json';
      a.click();
      setStatus('No dev server to save through: downloaded props.json instead (copy it to apps/web/src/scene/).');
    }
  };

  const r = 7 / zoom; // handle radius in room px, constant on screen
  const P = (p: Pt) => px(p);
  const poly = (pts: Pt[]) => pts.map((p) => P(p).join(',')).join(' ');
  const isSel = (s: Sel) => JSON.stringify(s) === JSON.stringify(sel);
  const handle = (s: Sel, p: Pt, color: string, key: string, shape: 'circle' | 'square' = 'circle') => {
    const [x, y] = P(p);
    const common = {
      fill: isSel(s) ? '#fff' : color,
      stroke: '#04131a',
      strokeWidth: 1.5 / zoom,
      style: { cursor: 'move', pointerEvents: 'auto' as const },
      onPointerDown: startDrag(s),
    };
    return shape === 'circle' ? <circle key={key} cx={x} cy={y} r={r} {...common} /> : <rect key={key} x={x - r} y={y - r} width={r * 2} height={r * 2} {...common} />;
  };

  const selProp = sel && 'p' in sel ? draft.props[sel.p] : null;

  return (
    <>
      <div
        ref={overlay}
        data-ui
        className="pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{ width: ROOM_W, height: ROOM_H }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {gridUrl && <img src={gridUrl} alt="" className="absolute inset-0 h-full w-full" style={{ imageRendering: 'pixelated' }} />}
        <svg width={ROOM_W} height={ROOM_H} viewBox={`0 0 ${ROOM_W} ${ROOM_H}`} className="absolute inset-0 overflow-visible">
          {draft.nav.areas.map((a, ai) => (
            <polygon key={'a' + ai} points={poly(a.poly)} fill="none" stroke={a.level === 'deck' ? '#60A5FA' : '#34D399'} strokeWidth={2 / zoom} strokeDasharray={`${8 / zoom} ${5 / zoom}`} />
          ))}
          {blocks.map((b, i) => (
            <polygon key={'o' + i} points={b.poly.map((p) => p.join(',')).join(' ')} fill="rgb(248 113 113 / .22)" stroke="#F87171" strokeWidth={1.2 / zoom} />
          ))}
          {show.paths &&
            walkers.map((w) =>
              w.path.length ? <polyline key={'w' + w.id} points={[w.pos, ...w.path.map((p) => [p.x, p.y] as Pt)].map((p) => p.join(',')).join(' ')} fill="none" stroke="#FBBF24" strokeWidth={2.5 / zoom} /> : null,
            )}
          <line {...lineProps(P(draft.nav.stairs[0]), P(draft.nav.stairs[1]))} stroke="#E879F9" strokeWidth={3 / zoom} />

          {draft.nav.areas.map((a, ai) => a.poly.map((p, i) => handle({ t: 'area', a: ai, i }, p, a.level === 'deck' ? '#60A5FA' : '#34D399', `av${ai}-${i}`, 'square')))}
          {draft.nav.blocks.map((b, bi) => b.poly.map((p, i) => handle({ t: 'block', b: bi, i }, p, '#F87171', `bv${bi}-${i}`, 'square')))}
          {handle({ t: 'stairs', i: 0 }, draft.nav.stairs[0], '#E879F9', 'st0')}
          {handle({ t: 'stairs', i: 1 }, draft.nav.stairs[1], '#E879F9', 'st1')}

          {draft.props.map((p, pi) => (
            <g key={p.id}>
              {p.foot && handle({ t: 'foot', p: pi, i: -1 }, p.foot, '#FACC15', `f${pi}`, 'square')}
              {p.sprites?.map((s, si) => handle({ t: 'foot', p: pi, i: si }, s.foot, '#FACC15', `f${pi}-${si}`, 'square'))}
              {p.face && handle({ t: 'face', p: pi }, p.face, '#A78BFA', `fc${pi}`)}
              {p.spots?.map((s, si) => {
                const [x, y] = P(s);
                return (
                  <g key={si}>
                    {handle({ t: 'spot', p: pi, i: si }, s, '#22D3EE', `s${pi}-${si}`)}
                    <text x={x + r * 1.4} y={y + r * 0.5} fontSize={11 / zoom} fill="#E6EDF7" stroke="#04131a" strokeWidth={3 / zoom} paintOrder="stroke" style={{ pointerEvents: 'none' }}>
                      {spotIds(p)[si]}
                    </text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      {/* panel */}
      <div data-ui className="absolute bottom-4 left-4 w-[300px] rounded-[10px] border border-border bg-surface/97 p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/.45)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] tracking-[0.1em] text-accent">LAYOUT HELPER</span>
          <a href={location.pathname} className="text-muted hover:text-text">
            exit
          </a>
        </div>
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-muted">
          {(['grid', 'blocks', 'paths'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {k}
            </label>
          ))}
        </div>
        <Legend />
        {sel ? (
          <div className="mt-2 rounded-md border border-border p-2">
            <div className="font-medium">{label(draft, sel)}</div>
            <div className="font-mono text-muted">{pointOf(draft, sel)?.join(', ')} %</div>
            {selProp && sel.t === 'foot' && (
              <label className="mt-1 flex items-center gap-2">
                width %
                <input
                  type="number"
                  step={0.1}
                  className="w-20 rounded border border-border bg-bg px-1"
                  value={sel.i < 0 ? selProp.width : selProp.sprites?.[sel.i]?.width}
                  onChange={(e) => {
                    const d = clone(draft);
                    const p = d.props[sel.p];
                    const v = round1(Number(e.target.value));
                    if (sel.i < 0) p.width = v;
                    else if (p.sprites) p.sprites[sel.i].width = v;
                    commit(d);
                  }}
                />
              </label>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selProp && (
                <Btn
                  onClick={() => {
                    const d = clone(draft);
                    const p = d.props[(sel as { p: number }).p];
                    const base = p.spots?.[p.spots.length - 1] ?? p.foot ?? [50, 50];
                    p.spots = [...(p.spots ?? []), [round1(base[0] + 1.5), round1(base[1] + 1)]];
                    commit(d);
                  }}
                >
                  + spot
                </Btn>
              )}
              {(sel.t === 'area' || sel.t === 'block') && (
                <Btn
                  onClick={() => {
                    const d = clone(draft);
                    const ring = sel.t === 'area' ? d.nav.areas[sel.a].poly : d.nav.blocks[sel.b].poly;
                    const a = ring[sel.i];
                    const b = ring[(sel.i + 1) % ring.length];
                    ring.splice(sel.i + 1, 0, [round1((a[0] + b[0]) / 2), round1((a[1] + b[1]) / 2)]);
                    commit(d);
                  }}
                >
                  + corner after
                </Btn>
              )}
              {(sel.t === 'spot' || sel.t === 'area' || sel.t === 'block') && (
                <Btn
                  onClick={() => {
                    const d = clone(draft);
                    if (removeSel(d, sel)) {
                      setSel(null);
                      commit(d);
                    }
                  }}
                >
                  delete
                </Btn>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-muted">Click a handle to select it. Drag to move, arrows to nudge (Shift ×10), Delete to remove.</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Btn
            onClick={() => {
              const d = clone(draft);
              d.nav.blocks.push({ id: `block-${d.nav.blocks.length + 1}`, level: 'floor', poly: [[48, 60], [51, 61.5], [48, 63], [45, 61.5]] });
              commit(d);
            }}
          >
            + obstacle
          </Btn>
          <Btn onClick={() => navigator.clipboard?.writeText(serializeLayout(draft)).then(() => setStatus('Copied props.json to the clipboard.'))}>copy</Btn>
          <button onClick={save} className="ml-auto h-7 rounded-md bg-accent px-3 font-medium text-[#04131a] disabled:opacity-50" disabled={!dirty}>
            Save
          </button>
        </div>
        {status && <p className="mt-2 text-muted">{status}</p>}
      </div>
    </>
  );
}

function removeSel(d: LayoutData, s: Sel): boolean {
  if (s.t === 'spot') {
    const spots = d.props[s.p].spots;
    if (!spots || spots.length <= 1) return false; // the server needs at least one spot per prop that has them
    spots.splice(s.i, 1);
    return true;
  }
  if (s.t === 'area' || s.t === 'block') {
    const ring = s.t === 'area' ? d.nav.areas[s.a].poly : d.nav.blocks[s.b].poly;
    if (ring.length > 3) ring.splice(s.i, 1);
    else if (s.t === 'block') d.nav.blocks.splice(s.b, 1);
    else return false;
    return true;
  }
  return false;
}

const lineProps = (a: Pt, b: Pt) => ({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="h-7 rounded-md border border-border px-2 hover:bg-surface-2">
      {children}
    </button>
  );
}

function Legend() {
  const item = (color: string, text: string, square = false) => (
    <span className="flex items-center gap-1">
      <span className={`inline-block size-2.5 ${square ? '' : 'rounded-full'}`} style={{ background: color }} />
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
      {item('#22D3EE', 'spot')}
      {item('#FACC15', 'sprite foot', true)}
      {item('#A78BFA', 'facing')}
      {item('#34D399', 'floor', true)}
      {item('#60A5FA', 'deck', true)}
      {item('#F87171', 'obstacle', true)}
      {item('#E879F9', 'stairs')}
    </div>
  );
}
