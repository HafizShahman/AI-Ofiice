import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { AgentState } from '@ai-office/shared';
import { OfficeScene, type SceneAgent } from '../scene/OfficeScene.ts';
import { activityLine, modelLine, ROLE_COLOR, statusGroup, STATUS_COLOR } from '../scene/layout.ts';
import { useOffice } from '../store.ts';
import { Icon } from '../ui/icons.tsx';
import { Helper } from './Helper.tsx';
import { useCeoRounds } from './useCeoRounds.ts';

const HELPER = new URLSearchParams(location.search).has('helper');

/** The live scene, shared with the roster/inspector/keyboard so they can drive the camera. */
export const sceneRef: { current: OfficeScene | null } = { current: null };
/** Overhead tag elements by agent id; the scene moves them every frame. */
const tagEls = new Map<string, HTMLElement>();

const ceoWalking = () => sceneRef.current?.isWalking('ceo') ?? null;

export function OfficeView({ children }: { children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const agents = useOffice((s) => s.agents);
  const selected = useOffice((s) => s.selected);
  const following = useOffice((s) => s.following);
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.startedAt - b.startedAt), [agents]);

  // mount the scene once
  useEffect(() => {
    const scene = new OfficeScene(canvas.current!, tagEls);
    sceneRef.current = scene;
    const ro = new ResizeObserver(([e]) => scene.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const ceo = useCeoRounds(ceoWalking);
  useEffect(() => {
    const ceoAgent: SceneAgent = { id: 'ceo', color: ROLE_COLOR.ceo, spot: ceo.spot, status: 'idle', activity: ceo.activity };
    sceneRef.current?.setAgents([
      ceoAgent,
      ...list.map((a) => ({ id: a.id, color: ROLE_COLOR[a.role], spot: a.spot, status: a.status, activity: a.activity })),
    ]);
  }, [list, ceo]);

  useEffect(() => {
    sceneRef.current?.setSelected(selected);
    if (selected) sceneRef.current?.focus(selected, following);
  }, [selected, following]);

  // drag to pan, click to select, wheel to zoom, double-click to follow
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sceneRef.current?.zoomBy(Math.exp(-e.deltaY * 0.0015), local(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={wrap}
      className="relative h-full w-full touch-none select-none overflow-hidden bg-[#0f1324]"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-ui]')) return;
        drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const scene = sceneRef.current;
        if (!scene) return;
        if (!d) {
          const hit = scene.hitTest(local(e).x, local(e).y);
          wrap.current!.style.cursor = hit && hit !== 'ceo' ? 'pointer' : 'grab';
          return;
        }
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        scene.panBy(dx, dy);
        useOffice.getState().setFollowing(false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        const hit = sceneRef.current?.hitTest(local(e).x, local(e).y) ?? null;
        if (hit !== 'ceo') useOffice.getState().select(hit);
      }}
      onDoubleClick={(e) => {
        const hit = sceneRef.current?.hitTest(local(e).x, local(e).y);
        if (hit && hit !== 'ceo') {
          useOffice.getState().select(hit);
          useOffice.getState().setFollowing(true);
        }
      }}
    >
      <canvas
        ref={canvas}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Office: ${list.filter((a) => statusGroup(a) === 'working').length} working, ${list.filter((a) => a.status === 'blocked').length} blocked`}
      />

      {/* overhead tags, positioned by the scene every frame */}
      <div className="pointer-events-none absolute inset-0">
        <Tag id="ceo" name="You" sub="CEO" line={ceo.line} color={ROLE_COLOR.ceo} />
        {list.map((a) => (
          <AgentTag key={a.id} a={a} selected={a.id === selected} />
        ))}
      </div>

      <CameraControls />
      {HELPER ? <Helper /> : children}
    </div>
  );
}

function AgentTag({ a, selected }: { a: AgentState; selected: boolean }) {
  return <Tag id={a.id} name={a.name} sub={a.project} line={activityLine(a)} meta={modelLine(a)} color={STATUS_COLOR[statusGroup(a)]} blocked={a.status === 'blocked'} selected={selected} />;
}

function Tag(p: { id: string; name: string; sub: string; line: string; meta?: string; color: string; blocked?: boolean; selected?: boolean }) {
  return (
    <div
      ref={(el) => {
        if (el) tagEls.set(p.id, el);
        else tagEls.delete(p.id);
      }}
      className="absolute left-0 top-0 will-change-transform"
      style={{ display: 'none' }}
    >
      <div
        className={`mb-1 max-w-[220px] rounded-md border px-2 py-1 leading-tight shadow-[0_4px_12px_rgb(0_0_0/.4)] ${
          p.blocked ? 'border-warning/70 bg-[#1d1708]/92 shadow-[0_0_12px_rgb(251_191_36/.35)]' : p.selected ? 'border-accent/70 bg-[#0b1220]/92' : 'border-border bg-[#0b1220]/88'
        }`}
      >
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[12px]">
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: p.color }} />
          <span className="font-semibold">{p.name}</span>
          <span className="truncate text-muted">· {p.sub}</span>
        </div>
        <div className={`flex items-center gap-1 truncate font-mono text-[11px] ${p.blocked ? 'text-warning' : 'text-muted'}`}>
          {p.blocked && <Icon name="hand" size={11} />}
          {p.line}
        </div>
        {p.meta && <div className="truncate font-mono text-[10px] text-accent/80">{p.meta}</div>}
      </div>
    </div>
  );
}

function CameraControls() {
  const selected = useOffice((s) => s.selected);
  const following = useOffice((s) => s.following);
  const btn = 'grid size-9 place-items-center rounded-md text-text hover:bg-surface-2 disabled:opacity-40';
  return (
    <div data-ui className="absolute bottom-4 right-4 flex gap-1 rounded-[10px] border border-border bg-surface/95 p-1 shadow-[0_8px_24px_rgb(0_0_0/.35)]">
      <button className={btn} aria-label="Reset view" title="Reset view (0)" onClick={() => sceneRef.current?.fit()}>
        <Icon name="reset" size={16} />
      </button>
      <button className={btn} aria-label="Zoom in" title="Zoom in (+)" onClick={() => sceneRef.current?.zoomBy(1.25)}>
        <Icon name="plus" size={16} />
      </button>
      <button className={btn} aria-label="Zoom out" title="Zoom out (−)" onClick={() => sceneRef.current?.zoomBy(0.8)}>
        <Icon name="minus" size={16} />
      </button>
      <button
        className={`${btn} ${following ? 'bg-accent/15 text-accent' : ''}`}
        aria-label="Follow selected agent"
        aria-pressed={following}
        title="Follow selected (Shift+F)"
        disabled={!selected}
        onClick={() => useOffice.getState().setFollowing(!following)}
      >
        <Icon name="locate" size={16} />
      </button>
    </div>
  );
}
