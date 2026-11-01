import type { AgentState, AiState, ChatMessage, ServerMessage } from '@ai-office/shared';
import { config } from './config.ts';
import { channelHistory, clearChannel, countEvents, recentEvents, saveMessage, saveSetting, setting } from './db.ts';
import { ask, buildContext, checkAvailable, describeAgent, systemPrompt } from './manager.ts';
import type { Office } from './state.ts';

/**
 * Chat: #office (the Office Manager) and one DM channel per robot ("dm:<agentId>").
 * Slash commands are answered here instantly and cost nothing; anything else goes to
 * the manager AI when it is on.
 */

export interface ChatDeps {
  office: Office;
  push(msg: ServerMessage): void;
  sim: { running: boolean };
  setSim(on: boolean): void;
  approvals: { enabled: boolean; setEnabled(on: boolean): void };
}

const HELP = [
  '`/status` office summary · `/agents` who is here · `/who <role or name>`',
  '`/ai on` · `/ai off` the Office Manager · `/approvals on|off` answer permission prompts here · `/sim on|off` the demo · `/clear` this channel',
  'Anything else is a question for the Office Manager (when AI is on).',
].join('\n');

export const midnight = () => new Date().setHours(0, 0, 0, 0);

export class Chat {
  private deps: ChatDeps;
  private busy = new Set<string>();
  ai: AiState;

  constructor(deps: ChatDeps) {
    this.deps = deps;
    const saved = setting('ai_enabled');
    this.ai = { enabled: saved ? saved === '1' : config.ai.enabled, model: config.ai.model, available: null };
    if (this.ai.enabled) void this.refreshAvailable();
  }

  history(channel: string): ChatMessage[] {
    return channelHistory(channel);
  }

  /** Post a message: stored, then broadcast. */
  post(m: Omit<ChatMessage, 'id' | 'ts'>): ChatMessage {
    const msg = saveMessage({ ...m, ts: Date.now() });
    this.deps.push({ type: 'chat', message: msg });
    return msg;
  }

  system(channel: string, body: string, tone: ChatMessage['tone'] = 'info', agentId?: string): void {
    this.post({ channel, author: 'system', body, tone, agentId });
  }

  async setAi(on: boolean): Promise<void> {
    this.ai = { ...this.ai, enabled: on };
    saveSetting('ai_enabled', on ? '1' : '0');
    this.deps.push({ type: 'ai', ai: this.ai });
    if (on) await this.refreshAvailable();
  }

  private async refreshAvailable(): Promise<void> {
    const available = await checkAvailable();
    this.ai = { ...this.ai, available };
    this.deps.push({ type: 'ai', ai: this.ai });
  }

  /** A user message arrived on a channel. */
  async handle(channel: string, body: string): Promise<void> {
    const text = body.trim().slice(0, 2000);
    if (!text) return;
    if (!validChannel(channel)) return;
    this.post({ channel, author: 'you', body: text });
    if (text.startsWith('/')) return this.command(channel, text);
    if (!this.ai.enabled) {
      this.system(channel, 'The Office Manager is off, so nobody reads questions here. Turn it on with `/ai on` (it runs `claude -p` with Haiku), or try `/status`.');
      return;
    }
    if (this.busy.has(channel)) {
      this.system(channel, 'Still answering your last question. One moment.');
      return;
    }
    await this.answer(channel, text);
  }

  private agentFor(channel: string): AgentState | undefined {
    return channel.startsWith('dm:') ? this.deps.office.agents.get(channel.slice(3)) : undefined;
  }

  private async answer(channel: string, question: string): Promise<void> {
    const dmId = channel.startsWith('dm:') ? channel.slice(3) : undefined;
    const asAgent = this.agentFor(channel);
    if (dmId && !asAgent) {
      this.system(channel, 'This agent has left the office, so it can’t answer. Ask in #office instead.');
      return;
    }
    this.busy.add(channel);
    this.deps.push({ type: 'typing', channel, on: true });
    try {
      const n = config.ai.contextEvents;
      const context = buildContext({
        agents: this.deps.office.agents,
        // tool_end lines only repeat the tool_start before them: skip them to save tokens
        events: (dmId ? recentEvents(n * 2, dmId) : recentEvents(n * 2)).filter((e) => e.kind !== 'tool_end').slice(-n),
        chat: channelHistory(channel, 9).slice(0, -1), // earlier turns, without the question itself
        doneToday: countEvents('turn_done', midnight()),
        sim: this.deps.sim.running,
      });
      const prompt = `OFFICE STATE\n${context}\n\nQUESTION\n${question}`;
      const r = await ask(systemPrompt(asAgent), prompt);
      if (r.ok) this.post({ channel, author: asAgent ? 'agent' : 'manager', name: asAgent?.name, body: r.text, agentId: asAgent?.id });
      else this.system(channel, r.text, 'fail');
      if (!r.ok && r.text.includes("Couldn't find")) this.ai = { ...this.ai, available: false };
    } finally {
      this.busy.delete(channel);
      this.deps.push({ type: 'typing', channel, on: false });
      this.deps.push({ type: 'ai', ai: this.ai });
    }
  }

  private command(channel: string, text: string): void {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').toLowerCase();
    const office = this.deps.office;
    const list = [...office.agents.values()];
    switch (cmd.toLowerCase()) {
      case 'help':
        return this.system(channel, HELP);
      case 'status': {
        const c = (f: (a: AgentState) => boolean) => list.filter(f).length;
        const projects = new Map<string, number>();
        for (const a of list) projects.set(a.project, (projects.get(a.project) ?? 0) + 1);
        const blocked = list.filter((a) => a.status === 'blocked');
        const lines = [
          `● ${c((a) => a.status === 'working' || a.status === 'arriving')} working · ◐ ${c((a) => ['idle', 'break', 'charging'].includes(a.status))} idle · ✋ ${blocked.length} blocked · ✓ ${countEvents('turn_done', midnight())} done today`,
          projects.size ? `projects: ${[...projects].map(([p, n]) => `${p} (${n})`).join(' · ')}` : 'Nobody is in the office.',
          ...blocked.map((a) => `${a.name} is waiting for permission${a.tool ? `: ${a.tool}${a.summary ? ` → ${a.summary}` : ''}` : ''}`),
        ];
        return this.system(channel, lines.join('\n'), blocked.length ? 'warn' : 'info');
      }
      case 'agents':
        return this.system(channel, list.length ? list.map((a) => describeAgent(a, office.agents).replace(/; \d+ tool calls.*$/, '')).join('\n') : 'Nobody is in the office.');
      case 'who': {
        if (!arg) return this.system(channel, 'Usage: `/who <role or name>`, e.g. `/who researcher`');
        const hits = list.filter((a) => a.role.includes(arg) || a.name.toLowerCase().includes(arg) || a.agentType?.toLowerCase().includes(arg));
        return this.system(channel, hits.length ? hits.map((a) => `${a.name} · ${a.project} · ${a.status} · ${a.activity}`).join('\n') : `Nobody matching “${arg}”.`);
      }
      case 'clear':
        clearChannel(channel);
        this.deps.push({ type: 'chat.clear', channel });
        return;
      case 'sim':
      case 'demo': {
        const on = arg ? arg === 'on' : !this.deps.sim.running;
        this.deps.setSim(on);
        return this.system(channel, on ? 'Demo started.' : 'Demo stopped; demo agents are leaving.');
      }
      case 'approvals':
      case 'approve': {
        const ap = this.deps.approvals;
        if (arg !== 'on' && arg !== 'off')
          return this.system(channel, `Approving from the office is ${ap.enabled ? 'on' : 'off'}. Use \`/approvals on\` or \`/approvals off\`.`);
        ap.setEnabled(arg === 'on');
        return this.system(
          channel,
          arg === 'on'
            ? 'Approving from the office is on: permission prompts wait here with Allow / Deny before going to the terminal. If you installed the hooks before this feature, re-run `npm run install-hooks` once.'
            : 'Approving from the office is off: permission prompts go straight to the terminal.',
        );
      }
      case 'ai': {
        if (arg !== 'on' && arg !== 'off') return this.system(channel, `The Office Manager is ${this.ai.enabled ? 'on' : 'off'} (${this.ai.model}). Use \`/ai on\` or \`/ai off\`.`);
        void this.setAi(arg === 'on');
        return this.system(channel, arg === 'on' ? `Office Manager on (${this.ai.model}). Each question runs one \`claude -p\` call.` : 'Office Manager off. Slash commands still work.');
      }
      default:
        return this.system(channel, `Unknown command \`/${cmd}\`.\n${HELP}`);
    }
  }
}

export function validChannel(c: string): boolean {
  return c === 'office' || /^dm:[\w.:-]{1,100}$/.test(c);
}
