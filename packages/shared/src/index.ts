// Contracts shared by the office server and the web app.
// Type-only on purpose: the server imports these with `import type`, so Node never loads this file at runtime.

export type Role = 'lead' | 'researcher' | 'architect' | 'engineer' | 'qa' | 'devops' | 'designer';

export type AgentStatus =
  | 'arriving' // walking in from the door
  | 'working'
  | 'blocked' // waiting for a permission decision
  | 'idle' // at its desk, nothing happening
  | 'break' // coffee or lounge
  | 'charging' // long idle or compacting context
  | 'done' // turn finished, celebrating briefly
  | 'leaving'; // walking out to the door

export type Activity =
  | 'arriving'
  | 'thinking'
  | 'coding'
  | 'researching'
  | 'running'
  | 'browsing'
  | 'delegating'
  | 'planning'
  | 'blocked'
  | 'idle'
  | 'coffee'
  | 'lounge'
  | 'charging'
  | 'done'
  | 'leaving';

/** Kinds of prop an agent can walk to. Matches `kind` in apps/web/src/scene/props.json. */
export type PropKind =
  | 'desk'
  | 'archive'
  | 'server-bank'
  | 'comms'
  | 'holo-table'
  | 'whiteboard'
  | 'approval'
  | 'coffee'
  | 'lounge'
  | 'charging'
  | 'bell'
  | 'door';

export type EventKind =
  | 'spawn'
  | 'leave'
  | 'prompt'
  | 'tool_start'
  | 'tool_end'
  | 'tool_fail'
  | 'blocked'
  | 'notify'
  | 'turn_done'
  | 'task_created'
  | 'task_done'
  | 'compact';

/** A Claude Code hook payload, normalised and redacted. Full tool input is never stored. */
export interface OfficeEvent {
  id: string;
  ts: number;
  sessionId: string;
  /** sessionId for the main agent, agent_id for subagents */
  agentId: string;
  parentAgentId?: string;
  kind: EventKind;
  tool?: string;
  /** short and redacted, e.g. "Edit TaskCard.tsx", "npm test" */
  summary?: string;
  cwd: string;
  /** basename(cwd), shown as the agent's team */
  project: string;
  agentType?: string;
  /** reasoning effort Claude Code reports for the session, e.g. "xhigh" */
  effort?: string;
  /** only when the hook payload names it (Claude Code's don't today); see AgentState.model */
  model?: string;
  /** on an Agent/Task call: the role its wording suggests ("research the docs" → researcher). The wording itself is not kept. */
  roleHint?: Role;
}

export interface AgentState {
  id: string;
  sessionId: string;
  parentId?: string;
  name: string;
  role: Role;
  agentType?: string;
  /** full model id, e.g. "claude-sonnet-5-5". Read from the agent's transcript, so unknown when the server can't see it. */
  model?: string;
  /** latest effort level seen on the agent's events: low, medium, high, xhigh, max */
  effort?: string;
  project: string;
  cwd: string;
  status: AgentStatus;
  activity: Activity;
  /** prop spot the agent is at or walking to, e.g. "desk-3", "coffee-1" */
  spot: string | null;
  /** desk number (1-based) this agent owns while it is in the office */
  desk: number | null;
  tool?: string;
  summary?: string;
  startedAt: number;
  lastEventAt: number;
  statusSince: number;
  counts: { tools: number; edits: number; commands: number; failures: number };
}

export interface StateSnapshot {
  agents: AgentState[];
  events: OfficeEvent[];
  sim: boolean;
  ai: AiState;
  /** turn_done events since local midnight */
  doneToday: number;
  approvals: ApprovalsState;
  dispatch: DispatchState;
  board: BoardItem[];
}

/**
 * One note on the mission board. Tasks are open or done; reminders have a due time and go
 * `alerting` when it arrives, until you dismiss, snooze or complete them.
 */
export interface BoardItem {
  id: number;
  kind: 'task' | 'reminder';
  text: string;
  state: 'open' | 'alerting' | 'done';
  /** reminders: when it fires (ms since epoch) */
  due?: number;
  repeat?: 'daily' | 'weekly';
  createdAt: number;
  doneAt?: number;
}

/** Tasks started from the office: a new `claude -p` agent in a project folder (opt-in). */
export interface DispatchState {
  enabled: boolean;
  /** what a dispatched agent may do: plan = read and investigate only, acceptEdits = may also edit files */
  mode: 'plan' | 'acceptEdits';
  /** where a task can run: folders saved in Settings (saved) plus ones the office has seen agents work in */
  projects: { path: string; name: string; saved?: boolean }[];
  /** the folder used last, preselected in the composer */
  last: string | null;
  /** tasks still running (their agent's DM channel is dm:<id>) */
  running: { id: string; task: string; project: string; startedAt: number }[];
  /** null = not checked yet; false = the `claude` command could not be run */
  available: boolean | null;
}

/** A permission request held open so you can answer it from the office (opt-in). */
export interface Approval {
  id: string;
  agentId: string;
  tool: string;
  /** redacted: the command, file or host being asked about (memory only, never stored) */
  detail: string;
  ts: number;
  expiresAt: number;
  /** a demo request: answering it changes nothing real */
  sim: boolean;
  /** AskUserQuestion: what is being asked, to answer from the office (memory only, never stored) */
  questions?: AskQuestion[];
  /** the question reached the office but couldn't be held: shown to read, answered in the terminal */
  viewOnly?: boolean;
}

/** One question of an AskUserQuestion call, tidied for display. Answers go back by option index. */
export interface AskQuestion {
  question: string;
  /** short chip label (Claude Code limits it to 12 characters) */
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** 'replied' = a question was answered from the office; 'answered' = settled elsewhere (e.g. in the terminal). */
export type ApprovalOutcome = 'allow' | 'deny' | 'replied' | 'terminal' | 'timeout' | 'answered';

export interface ApprovalsState {
  /** answer permission prompts from the office */
  enabled: boolean;
  waitSec: number;
  pending: Approval[];
}

/** The Office Manager AI (runs `claude -p` on the server's machine). */
export interface AiState {
  enabled: boolean;
  model: string;
  /** how many recent events the manager is shown */
  contextEvents: number;
  /** null = not checked yet; false = the `claude` command could not be run */
  available: boolean | null;
}

/** Chat channels: "office" (the manager) or "dm:<agentId>" (one per robot). #activity is built in the browser. */
export type ChatAuthor = 'you' | 'manager' | 'agent' | 'system';

export interface ChatMessage {
  id: number;
  ts: number;
  channel: string;
  author: ChatAuthor;
  /** display name for 'agent' (the manager answering as that robot) */
  name?: string;
  body: string;
  /** system lines: how to colour them */
  tone?: 'info' | 'warn' | 'fail' | 'ok';
  /** agent the line is about (click flies the camera there) */
  agentId?: string;
  /** a page the manager published (card with the link and the source) */
  artifact?: ArtifactRef;
}

export interface ArtifactRef {
  title: string;
  url: string;
  /** the page's HTML as written (capped), so the source can be read in the chat */
  html?: string;
}

/** Server → browser over /ws */
export type ServerMessage =
  | { type: 'snapshot'; state: StateSnapshot }
  | { type: 'agent'; agent: AgentState }
  | { type: 'agent.remove'; id: string }
  | { type: 'event'; event: OfficeEvent }
  | { type: 'sim'; on: boolean }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat.clear'; channel: string }
  | { type: 'typing'; channel: string; on: boolean }
  | { type: 'ai'; ai: AiState }
  | { type: 'dispatch'; dispatch: DispatchState }
  | { type: 'board'; items: BoardItem[] }
  /** something was just added: the CEO walks to the board to pin it */
  | { type: 'board.pin'; id: number }
  | { type: 'approvals'; enabled: boolean; waitSec: number }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval.done'; id: string; outcome: ApprovalOutcome };

/** What GET /api/settings reports: read-only facts the settings drawer shows. */
export interface SettingsInfo {
  version: string;
  /** whether AI Office hooks were found in a Claude Code settings file the server can read (null = can't see ~/.claude) */
  hooks: { installed: boolean | null; file: string | null; url: string | null; permissionTimeoutSec: number | null };
  roles: { role: string; match: string }[];
  timers: { idleAfterSec: number; breakAfterSec: number; chargeAfterSec: number; staleAfterSec: number; doneHoldSec: number };
  desks: number;
  models: string[];
}
