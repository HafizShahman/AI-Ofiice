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
}

export interface AgentState {
  id: string;
  sessionId: string;
  parentId?: string;
  name: string;
  role: Role;
  agentType?: string;
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
}

/** The Office Manager AI (runs `claude -p` on the server's machine). */
export interface AiState {
  enabled: boolean;
  model: string;
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
  | { type: 'ai'; ai: AiState };
