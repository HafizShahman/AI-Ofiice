import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { AgentState } from '@ai-office/shared';
import { OfficeScene } from '../scene/OfficeScene.ts';
import { OfficeScene3D } from '../scene/OfficeScene3D.ts';
import type { OfficeSceneApi, SceneAgent } from '../scene/sceneApi.ts';
import { activityLine, modelLine, PROPS, ROLE_COLOR, spotIds, statusGroup, STATUS_COLOR } from '../scene/layout.ts';
import { bindSceneSound } from '../sound/cues.ts';
import { useOffice } from '../store.ts';
import { QUALITY_DPR, usePrefs, useUi } from '../ui/prefs.ts';
import { Icon } from '../ui/icons.tsx';
import { anchorEls } from '../scene/anchors.ts';
import { BoardHotspot } from '../ui/MissionBoard.tsx';
import { Helper } from './Helper.tsx';
import { useCeoRounds } from './useCeoRounds.ts';
import { MEETING_MAX_S, useMeeting } from './useMeeting.ts';

const HELPER = new URLSearchParams(location.search).has('helper');
/** ?view=2d / ?view=3d overrides the setting for this tab */
const VIEW = new URLSearchParams(location.search).get('view');

/** The 3D room unless ?view=2d, the setting is off, or the ?helper editor (2D only) is open. */
export const wants3d = (pref: boolean) => !HELPER && (VIEW === '3d' || (VIEW !== '2d' && pref));

/** The live scene, shared with the roster/inspector/keyboard so they can drive the camera. */
export const sceneRef: { current: OfficeSceneApi | null } = { current: null };
/** Overhead tag elements by agent id; the scene moves them every frame. */
const tagEls = new Map<string, HTMLElement>();

const ceoWalking = () => sceneRef.current?.isWalking('ceo') ?? null;

/** The CEO and the standby researcher are scenery rather than agents: they can't be selected. */
const fixture = (id: string | null | undefined) => id === 'ceo' || id === STANDBY_RESEARCHER;

/** Shown reading at the archive whenever no live agent has the researcher role, so that character is never missing. */
const STANDBY_RESEARCHER = 'standby-researcher';

export function OfficeView({ children }: { children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const agents = useOffice((s) => s.agents);
  const selected = useOffice((s) => s.selected);
  const following = useOffice((s) => s.following);
  const wallboard = useUi((s) => s.wallboard);
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.startedAt - b.startedAt), [agents]);
  const view3d = usePrefs((s) => wants3d(s.view3d));

  // mount the scene (again when switching between the 3D room and the painted office)
  useEffect(() => {
    const scene: OfficeSceneApi = view3d ? new OfficeScene3D(canvas.current!, tagEls) : new OfficeScene(canvas.current!, tagEls);
    scene.anchors = anchorEls;
    sceneRef.current = scene;
    const unbindSound = bindSceneSound(scene);
    const ro = new ResizeObserver(([e]) => scene.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    // settings: resolution cap, reduced motion, and the wallboard tour
    let cap = 0;
    const sync = () => {
      const p = usePrefs.getState();
      if (QUALITY_DPR[p.quality] !== cap) scene.setPixelRatioCap((cap = QUALITY_DPR[p.quality]));
      scene.reduceMotion = p.reduceMotion;
      scene.setTour(useUi.getState().wallboard && !p.reduceMotion);
    };
    sync();
    const unsubs = [usePrefs.subscribe(sync), useUi.subscribe(sync)];
    return () => {
      unsubs.forEach((u) => u());
      unbindSound();
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [view3d]);

  // the researcher only exists while an agent has that role (roles follow the work), so a standby one reads at the archive
  const researcherSpot = useMemo(() => {
    if (list.some((a) => a.role === 'researcher' && a.status !== 'leaving')) return null;
    const taken = new Set(list.map((a) => a.spot));
    return PROPS.filter((p) => p.kind === 'archive').flatMap(spotIds).find((sp) => !taken.has(sp)) ?? null;
  }, [list]);

  const meeting = useMeeting((s) => s.on);
  const pinTick = useOffice((s) => s.pinTick);
  const alerts = useOffice((s) => s.board.filter((i) => i.state === 'alerting').length);
  // handing the CEO a note (or a reminder coming due) sends them to the mission board
  const errand = pinTick + alerts;
  const ceo = useCeoRounds(ceoWalking, meeting, errand);
  // a meeting ends by itself, so nobody is stuck at the table if you forget it
  useEffect(() => {
    if (!meeting) return;
    const t = setTimeout(() => useMeeting.getState().set(false), MEETING_MAX_S * 1000);
    return () => clearTimeout(t);
  }, [meeting]);
  // each attendee keeps its seat for the whole meeting (so a status change doesn't reshuffle the table)
  const seats = useRef(new Map<string, string>());
  useEffect(() => {
    const seatIds = meeting ? spotIds(PROPS.find((p) => p.kind === 'meeting') ?? { id: 'meeting', kind: 'meeting' }) : [];
    const attendees = list.filter((a) => a.status !== 'blocked').map((a) => a.id);
    const held = seats.current;
    for (const id of [...held.keys()]) if (!meeting || !attendees.includes(id)) held.delete(id);
    for (const id of attendees) {
      if (!meeting || held.has(id)) continue;
      const free = seatIds.find((s) => ![...held.values()].includes(s));
      if (free) held.set(id, free); // no seat left: stays where it is
    }
    const at = (id: string, spot: string | null, activity: SceneAgent['activity']) => {
      const seat = held.get(id);
      return seat ? { spot: seat, activity: 'idle' as const } : { spot, activity };
    };
    const ceoAgent: SceneAgent = { id: 'ceo', color: ROLE_COLOR.ceo, spot: ceo.spot, status: 'idle', activity: meeting ? 'delegating' : ceo.activity };
    const standby: SceneAgent[] = researcherSpot ? [{ id: STANDBY_RESEARCHER, color: ROLE_COLOR.researcher, spot: researcherSpot, status: 'idle', activity: 'researching' }] : [];
    sceneRef.current?.setAgents([
      ceoAgent,
      ...standby,
      ...list.map((a) => ({ id: a.id, color: ROLE_COLOR[a.role], status: a.status, ...at(a.id, a.spot, a.activity) })),
    ]);
  }, [list, ceo, meeting, researcherSpot, view3d]);

  useEffect(() => {
    sceneRef.current?.setSelected(selected);
    // selecting leaves the camera where it is; only Follow (double-click, button, Shift+F) flies to the robot and locks on
    if (selected && following) sceneRef.current?.focus(selected, true);
  }, [selected, following, view3d]);

  // drag to pan, click to select, wheel to zoom, double-click to follow
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number; orbit: boolean } | null>(null);
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
        // right button or Shift/Alt + drag turns the 3D camera; a plain drag pans
        drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, orbit: e.button === 2 || e.shiftKey || e.altKey };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const scene = sceneRef.current;
        if (!scene) return;
        if (!d) {
          const hit = scene.hitTest(local(e).x, local(e).y);
          wrap.current!.style.cursor = hit && !fixture(hit) ? 'pointer' : 'grab';
          return;
        }
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        if (d.orbit && scene.orbitBy) scene.orbitBy(dx, dy);
        else {
          scene.panBy(dx, dy);
          useOffice.getState().setFollowing(false);
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved || d.orbit) return;
        const hit = sceneRef.current?.hitTest(local(e).x, local(e).y) ?? null;
        if (!fixture(hit)) useOffice.getState().select(hit);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        const hit = sceneRef.current?.hitTest(local(e).x, local(e).y);
        if (hit && !fixture(hit)) {
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
        {!wallboard && <BoardHotspot />}
        <Tag id="ceo" name="You" sub="CEO" line={meeting ? 'Holding a meeting' : ceo.line} color={ROLE_COLOR.ceo} />
        {researcherSpot && <Tag id={STANDBY_RESEARCHER} name="Researcher" sub="Standby" line="Ready to dig in" color={STATUS_COLOR.idle} />}
        {list.map((a) => (
          <AgentTag key={a.id} a={a} selected={a.id === selected} inMeeting={meeting && a.status !== 'blocked'} />
        ))}
      </div>

      {!wallboard && <CameraControls />}
      {HELPER ? <Helper /> : children}
    </div>
  );
}

function AgentTag({ a, selected, inMeeting }: { a: AgentState; selected: boolean; inMeeting: boolean }) {
  return <Tag id={a.id} name={a.name} sub={a.project} line={inMeeting ? 'In the meeting' : activityLine(a)} meta={modelLine(a)} color={STATUS_COLOR[statusGroup(a)]} blocked={a.status === 'blocked'} selected={selected} />;
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
        {p.line && (
          <div className={`flex items-center gap-1 truncate font-mono text-[11px] ${p.blocked ? 'text-warning' : 'text-muted'}`}>
            {p.blocked && <Icon name="hand" size={11} />}
            {p.line}
          </div>
        )}
        {p.meta && <div className="truncate font-mono text-[10px] text-accent/80">{p.meta}</div>}
      </div>
    </div>
  );
}

function CameraControls() {
  const selected = useOffice((s) => s.selected);
  const following = useOffice((s) => s.following);
  const meeting = useMeeting((s) => s.on);
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
      <button
        className={`${btn} ${meeting ? 'bg-accent/15 text-accent' : ''}`}
        aria-label={meeting ? 'End the meeting' : 'Call a meeting at the holo-table'}
        aria-pressed={meeting}
        title={meeting ? 'End the meeting' : 'Call everyone to a meeting at the holo-table'}
        onClick={() => useMeeting.getState().set(!meeting)}
      >
        <Icon name="users" size={16} />
      </button>
    </div>
  );
}
