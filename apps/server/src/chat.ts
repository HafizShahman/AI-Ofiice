import type { AgentState, AiState, ChatMessage, Provider, ServerMessage } from '@ai-office/shared';
import { config } from './config.ts';
import { channelHistory, clearChannel, countEvents, recentEvents, saveMessage, saveSetting, setting } from './db.ts';
import { buildContext, describeAgent, systemPrompt } from './manager.ts';
import { askAi, check, info, isProvider, LABEL, MODELS as PROVIDER_MODELS, PROVIDERS, validModel } from './providers/ai.ts';
import type { Office } from './state.ts';
import type { Dispatcher } from './dispatch.ts';
import { parseWhen, type Board } from './board.ts';

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
  dispatch: Dispatcher;
  board: Board;
}

const HELP = [
  '`/status` office summary · `/agents` who is here · `/who <role or name>`',
  '`/todo <task>` and `/remind <when> <what>` go to the CEO, who pins them on the mission board (`in 20m`, `at 15:30`, `tomorrow 9am`, `daily 9:00`) · `/board` lists it',
  '`/task <what to do>` start a new agent on it (in a DM: in that agent’s project; in #office: `/task @project <what>`) · `/tasks on|off|stop` · needs `/tasks on`',
  '`/ai on|off` the Office Manager · `/ai use claude|codex` and `/task --codex <what>` once Codex is ticked in Settings · `/approvals on|off` answer permission prompts here · `/sim on|off` the demo · `/clear` this channel',
  'Anything else is a question for the Office Manager (when AI is on). It can make a page (“make a chart of today’s activity”) and read a pasted `claude.ai/artifact` link.',
].join('\n');

/** Aliases `claude --model` accepts. */
export const MODELS = ['haiku', 'sonnet', 'opus'];

/** "Mon 14:30" in the user's timezone (`tz` = the browser's getTimezoneOffset), not the server's. */
const fmtAt = (ts: number, tz = new Date().getTimezoneOffset()) =>
  new Date(ts - tz * 60_000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export const midnight = () => new Date().setHours(0, 0, 0, 0);

export class Chat {
  private deps: ChatDeps;
  private busy = new Set<string>();
  ai: AiState;
  private provider: Provider = 'claude';
  private models: Record<Provider, string> = { claude: config.ai.model, codex: 'default' };
  private avail: Record<Provider, boolean | null> = { claude: null, codex: null };
  /** Which AIs are in use. Without a saved choice: Claude Code only (the behaviour before `npm run setup` existed). */
  private enabled: Record<Provider, boolean> = { claude: setting('claude_enabled') !== '0', codex: setting('codex_enabled') === '1' };
  private setupDone = setting('setup_done') === '1';

  constructor(deps: ChatDeps) {
    this.deps = deps;
    const saved = setting('ai_enabled');
    // saved choices from the settings drawer win over office.config.json (manager.ts reads config.ai at call time)
    const model = setting('ai_model');
    if (model && MODELS.includes(model)) config.ai.model = model;
    const ctx = Number(setting('ai_context_events'));
    if (ctx >= 5 && ctx <= 100) config.ai.contextEvents = ctx;
    const prov = setting('ai_provider');
    if (!PROVIDERS.some((p) => this.enabled[p])) this.enabled.claude = true;
    this.provider = isProvider(prov) && this.on(prov) ? prov : PROVIDERS.find((p) => this.on(p))!;
    this.models.claude = config.ai.model;
    for (const p of PROVIDERS) {
      const m = p === 'claude' ? null : setting(`ai_model_${p}`);
      if (m && validModel(p, m)) this.models[p] = m;
    }
    this.ai = this.build(saved ? saved === '1' : config.ai.enabled);
    void this.refreshAvailable(true);
  }

  /** The state the browser sees: the default provider's model and availability, plus every provider. */
  private build(enabled: boolean): AiState {
    return {
      enabled,
      provider: this.provider,
      providers: info(this.models, this.avail).filter((p) => this.on(p.id)),
      claudeEnabled: this.enabled.claude,
      codexEnabled: this.enabled.codex,
      setupDone: this.setupDone,
      model: this.models[this.provider],
      contextEvents: config.ai.contextEvents,
      available: this.avail[this.provider],
    };
  }

  private publish(enabled = this.ai.enabled): void {
    this.ai = this.build(enabled);
    this.deps.push({ type: 'ai', ai: this.ai });
  }

  /** Is this AI one of those in use? At least one always is. */
  private on(p: Provider): boolean {
    return this.enabled[p];
  }

  /** The AI to use for one thing: the default, or the one a task asked for. */
  choice(p?: Provider): { provider: Provider; model: string } {
    const provider = p && this.on(p) ? p : this.provider;
    return { provider, model: this.models[provider] };
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
    saveSetting('ai_enabled', on ? '1' : '0');
    this.publish(on);
    if (on) await this.refreshAvailable();
  }

  /** Switch an AI on or off. The last one can't be switched off; the default moves to one that is still on. */
  async setProviderEnabled(p: Provider, on: boolean): Promise<boolean> {
    if (!on && !PROVIDERS.some((o) => o !== p && this.enabled[o])) return false;
    this.enabled[p] = on;
    saveSetting(`${p}_enabled`, on ? '1' : '0');
    if (!on && this.provider === p) {
      this.provider = PROVIDERS.find((o) => this.enabled[o])!;
      saveSetting('ai_provider', this.provider);
    }
    this.markSetup();
    this.publish();
    if (on) await this.refreshAvailable(true);
    return true;
  }

  /** The AIs have been chosen (by `npm run setup` or in Settings), so the first-run card stops asking. */
  markSetup(): void {
    if (this.setupDone) return;
    this.setupDone = true;
    saveSetting('setup_done', '1');
    this.publish();
  }

  async setProvider(p: Provider): Promise<void> {
    if (!isProvider(p) || !this.on(p)) return;
    this.provider = p;
    saveSetting('ai_provider', p);
    this.publish();
    await this.refreshAvailable();
  }

  /** The model for a provider (default: the default provider). */
  setModel(model: string, p: Provider = this.provider): void {
    if (!validModel(p, model)) return;
    this.models[p] = model;
    if (p === 'claude') {
      config.ai.model = model;
      saveSetting('ai_model', model);
    } else saveSetting(`ai_model_${p}`, model);
    this.publish();
  }

  setContextEvents(n: number): void {
    const contextEvents = Math.round(Math.min(100, Math.max(5, n)));
    config.ai.contextEvents = contextEvents;
    saveSetting('ai_context_events', String(contextEvents));
    this.publish();
  }

  private async refreshAvailable(all = false): Promise<void> {
    const which = (all ? PROVIDERS : [this.provider]).filter((p) => this.on(p));
    await Promise.all(
      which.map(async (p) => {
        this.avail[p] = await check(p);
      }),
    );
    this.publish();
  }

  /** A user message arrived on a channel. */
  async handle(channel: string, body: string, tz?: number): Promise<void> {
    const text = body.trim().slice(0, 2000);
    if (!text) return;
    if (!validChannel(channel)) return;
    this.post({ channel, author: 'you', body: text });
    if (text.startsWith('/')) return this.command(channel, text, tz);
    if (!this.ai.enabled) {
      this.system(channel, `The Office Manager is off, so nobody reads questions here. Turn it on with \`/ai on\` (it runs ${LABEL[this.provider]}), or try \`/status\`.`);
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
      const { provider, model } = this.choice();
      const artifacts = provider === 'claude'; // only Claude Code has the Artifact tool
      const r = await askAi(systemPrompt(asAgent, { artifacts }), prompt, { provider, model, artifacts });
      if (r.ok) {
        const author = asAgent ? 'agent' : 'manager';
        // each page the manager published gets a card (link + source), then its answer
        for (const artifact of r.artifacts ?? []) this.post({ channel, author, name: asAgent?.name, body: artifact.title, agentId: asAgent?.id, artifact });
        this.post({ channel, author, name: asAgent?.name, body: r.text, agentId: asAgent?.id });
      }
      else this.system(channel, r.text, 'fail');
      if (!r.ok && r.text.includes("Couldn't find")) this.avail[provider] = false;
    } finally {
      this.busy.delete(channel);
      this.deps.push({ type: 'typing', channel, on: false });
      this.publish();
    }
  }

  /** `/todo` and `/remind`: hand a note to the CEO, who walks to the mission board and pins it. */
  private pin(channel: string, kind: 'task' | 'reminder', body: string, tz?: number): void {
    let text = body.trim();
    let opts: { due?: number; repeat?: 'daily' | 'weekly' } = {};
    if (kind === 'reminder') {
      const when = parseWhen(text, Date.now(), tz);
      if (!when || !when.rest) {
        return this.system(channel, 'When? Try `/remind in 20m call Sam`, `/remind at 15:30 stand-up`, `/remind tomorrow 9am pay rent` or `/remind daily 9:00 standup`.', 'warn');
      }
      text = when.rest;
      opts = { due: when.due, repeat: when.repeat };
    }
    const r = this.deps.board.add(kind, text, opts);
    if (!r.ok) return this.system(channel, r.error, 'warn');
    const at = r.item.due ? fmtAt(r.item.due, tz) : '';
    this.system(channel, kind === 'task' ? `📌 The CEO pinned a task on the mission board: ${r.item.text}` : `📌 The CEO pinned a reminder for ${at}${r.item.repeat ? ` (${r.item.repeat})` : ''}: ${r.item.text}`, 'ok');
  }

  /** `/task [@project] <text>`: start a new agent. In a DM it works in that agent's project. */
  private task(channel: string, text: string): void {
    const d = this.deps.dispatch;
    let rest = text.replace(/^\/task\s*/i, '');
    let provider: Provider | undefined;
    const flag = rest.match(/^--(claude|codex)\s+/i);
    if (flag) {
      provider = flag[1].toLowerCase() as Provider;
      rest = rest.slice(flag[0].length);
    }
    const projects = d.state().projects;
    const dm = this.agentFor(channel);
    let cwd: string | undefined = dm?.cwd;
    const tag = rest.match(/^@(\S+)\s*/);
    if (tag) {
      const name = tag[1].toLowerCase();
      const hit = projects.find((p) => p.name.toLowerCase() === name) ?? projects.find((p) => p.name.toLowerCase().startsWith(name));
      if (!hit) return this.system(channel, `No project “${tag[1]}”. Known: ${projects.map((p) => `\`${p.name}\``).join(', ') || 'none yet'}.`, 'warn');
      cwd = hit.path;
      rest = rest.slice(tag[0].length);
    }
    cwd ??= d.state().last ?? (projects.length === 1 ? projects[0].path : undefined);
    if (!rest.trim()) return this.system(channel, 'Usage: `/task [@project] <what to do>`');
    if (!cwd) return this.system(channel, `Which project? Use \`/task @project …\`. Known: ${projects.map((p) => `\`${p.name}\``).join(', ') || 'none yet (start Claude Code in a folder once)'}.`, 'warn');
    this.dispatchTask(channel, rest, cwd, provider);
  }

  /** Start a task and tell the channel (and #office) where to follow it. */
  dispatchTask(channel: string, task: string, cwd: string, provider?: Provider): { ok: boolean; error?: string; id?: string } {
    if (provider && !this.on(provider)) {
      const error = 'Codex is off. Tick “Use Codex” in Settings → Office Manager first.';
      this.system(channel, error, 'warn');
      return { ok: false, error };
    }
    const r = this.deps.dispatch.start(task, cwd, this.choice(provider));
    if (!r.ok) {
      this.system(channel, r.error, 'warn');
      return { ok: false, error: r.error };
    }
    const brief = task.trim().replace(/\s+/g, ' ').slice(0, 160);
    this.post({ channel: `dm:${r.id}`, author: 'you', body: task.trim().slice(0, 4000) });
    const line = `▶ New task in \`${r.project}\`: ${brief}. A new ${LABEL[this.choice(provider).provider]} agent is starting; its answer will land in its DM.`;
    this.system(channel, line, 'info');
    if (channel !== `dm:${r.id}`) this.system(`dm:${r.id}`, `Started from ${channel === 'office' ? '#office' : 'a DM'} in \`${r.project}\`.`, 'info');
    return { ok: true, id: r.id };
  }

  /** A dispatched task ended: its answer goes to its DM, a one-liner to #office. */
  taskFinished(r: { id: string; project: string; task: string; ok: boolean; stopped: boolean; text: string }): void {
    const dm = `dm:${r.id}`;
    const name = this.deps.office.agents.get(r.id)?.name;
    if (r.ok) this.post({ channel: dm, author: 'agent', name, agentId: r.id, body: r.text });
    else this.system(dm, r.stopped ? `Stopped.${r.text ? `\n${r.text}` : ''}` : `The task failed. ${r.text}`, r.stopped ? 'info' : 'fail', r.id);
    const brief = r.task.replace(/\s+/g, ' ').slice(0, 80);
    this.system('office', r.ok ? `✓ ${name ?? 'A task agent'} finished in \`${r.project}\`: ${brief}` : r.stopped ? `■ Task stopped in \`${r.project}\`: ${brief}` : `✕ A task failed in \`${r.project}\`: ${brief}`, r.ok ? 'ok' : r.stopped ? 'info' : 'fail', r.id);
  }

  private command(channel: string, text: string, tz?: number): void {
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
      case 'todo':
      case 'remind':
      case 'reminder':
        return this.pin(channel, cmd.toLowerCase() === 'todo' ? 'task' : 'reminder', text.replace(/^\/\w+\s*/, ''), tz);
      case 'board': {
        const items = this.deps.board.items().filter((i) => i.state !== 'done');
        const fmt = (t: number) => fmtAt(t, tz);
        return this.system(
          channel,
          items.length ? items.map((i) => (i.kind === 'task' ? `☐ ${i.text}` : `⏰ ${i.text} · ${i.state === 'alerting' ? 'due now' : fmt(i.due!)}${i.repeat ? ` · ${i.repeat}` : ''}`)).join('\n') : 'The mission board is empty. Try `/todo write the report` or `/remind in 20m stretch`.',
        );
      }
      case 'task':
        return this.task(channel, text);
      case 'tasks': {
        const d = this.deps.dispatch;
        if (arg === 'stop') {
          const ids = d.state().running.map((r) => r.id);
          ids.forEach((id) => d.stop(id));
          return this.system(channel, ids.length ? `Stopping ${ids.length} task${ids.length === 1 ? '' : 's'}.` : 'No task is running.');
        }
        if (arg !== 'on' && arg !== 'off') {
          const s = d.state();
          return this.system(channel, `Tasks from the office are ${s.enabled ? `on (${s.mode === 'plan' ? 'read-only plan mode' : 'may edit files'})` : 'off'}; ${s.running.length} running. Use \`/tasks on\`, \`/tasks off\` or \`/tasks stop\`.`);
        }
        void d.setEnabled(arg === 'on');
        return this.system(
          channel,
          arg === 'on'
            ? `Tasks from the office are on (${d.mode === 'plan' ? 'read-only plan mode: the agent investigates and proposes, it changes nothing' : 'the agent may edit files in the project'}). Try \`/task look at the failing tests and tell me why\`. Change the mode in Settings.`
            : 'Tasks from the office are off.',
        );
      }
      case 'ai': {
        const [sub, which] = arg.split(/\s+/);
        if (sub === 'use') {
          if (!isProvider(which)) return this.system(channel, `Which one? \`/ai use ${this.ai.providers.map((p) => p.id).join('` or `/ai use ')}\`.`, 'warn');
          if (!this.on(which)) return this.system(channel, `${LABEL[which]} is off. Tick it under Settings → Office Manager → AIs in use (or run \`npm run setup\`) first.`, 'warn');
          void this.setProvider(which);
          return this.system(channel, `Default AI is now ${LABEL[which]} (${this.models[which]}). Questions and new tasks use it. A task can pick another one: \`/task --${PROVIDERS.find((p) => p !== which)} …\`.`);
        }
        if (sub === 'model') {
          if (!which || !validModel(this.provider, which)) return this.system(channel, `Models for ${LABEL[this.provider]}: ${PROVIDER_MODELS[this.provider].map((m) => `\`${m}\``).join(', ')}.`, 'warn');
          this.setModel(which);
          return this.system(channel, `${LABEL[this.provider]} model: \`${which}\`.`);
        }
        if (sub !== 'on' && sub !== 'off') {
          const list = this.ai.providers.map((p) => `${p.id === this.provider ? '▸ ' : '  '}${p.label} (${p.model})${p.available === false ? ' — not found on this machine' : ''}`).join('\n');
          return this.system(channel, `The Office Manager is ${this.ai.enabled ? 'on' : 'off'}. AIs:\n${list}\nUse \`/ai on|off\`, \`/ai use <${PROVIDERS.join('|')}>\`, \`/ai model <name>\`.`);
        }
        void this.setAi(sub === 'on');
        return this.system(channel, sub === 'on' ? `Office Manager on (${LABEL[this.provider]}, ${this.models[this.provider]}). Each question runs one ${LABEL[this.provider]} call.` : 'Office Manager off. Slash commands still work.');
      }
      default:
        return this.system(channel, `Unknown command \`/${cmd}\`.\n${HELP}`);
    }
  }
}

export function validChannel(c: string): boolean {
  return c === 'office' || /^dm:[\w.:-]{1,100}$/.test(c);
}
