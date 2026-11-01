import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalOutcome, ApprovalsState, AskQuestion, OfficeEvent, ServerMessage } from '@ai-office/shared';
import { config } from './config.ts';
import { saveSetting, setting } from './db.ts';

/**
 * Answer permission prompts and AskUserQuestion questions from the office (opt-in, off by default).
 *
 * When it is on, a `PermissionRequest` hook call is NOT answered at once: the server holds the
 * HTTP request open for up to `approvals.waitSec` and shows Allow / Deny in the UI. Your click
 * becomes the hook's JSON decision. A question works the same way through a second, held
 * `PreToolUse` hook for AskUserQuestion: your answer goes back as `updatedInput` (the original
 * input plus `answers`), which makes Claude Code skip its own dialog. If nobody answers, you
 * choose "answer in terminal", the agent moves on, or Claude Code gives up on the hook, the
 * request is released with an empty body and Claude Code asks in the terminal as usual.
 */

export type HookDecision =
  | { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow' | 'deny'; message?: string } } }
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string; updatedInput: Record<string, unknown> } };

/** An AskUserQuestion held for an answer. The original input is kept (memory only) because the reply is that input plus `answers`. */
export interface Ask {
  input: Record<string, unknown>;
  questions: AskQuestion[];
}

/** One question's answer from the card: option indexes and/or free text. */
export interface Pick {
  picked: number[];
  other?: string;
}

interface Pending {
  approval: Approval;
  ask?: Ask;
  finish: (outcome: ApprovalOutcome, answers?: Record<string, string>) => void;
}

function decisionFor(outcome: ApprovalOutcome, ask?: Ask, answers?: Record<string, string>): HookDecision | null {
  if (ask)
    return outcome === 'replied' && answers
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Answered by the user from AI Office.', updatedInput: { ...ask.input, answers } } }
      : null;
  return outcome === 'allow'
    ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
    : outcome === 'deny'
      ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the user from AI Office.' } } }
      : null;
}

export class Approvals {
  enabled: boolean;
  readonly waitMs = (config.approvals?.waitSec ?? 45) * 1000;
  private pending = new Map<string, Pending>();
  private push: (m: ServerMessage) => void;
  /** told about every outcome (for the chat line); `answers` = what you replied to a question */
  onDone?: (a: Approval, outcome: ApprovalOutcome, answers?: Record<string, string>) => void;
  /** Claude Code dropped a held request within a couple of seconds: its hook timeout is too short */
  onShortHookTimeout?: (question: boolean) => void;

  constructor(push: (m: ServerMessage) => void) {
    this.push = push;
    this.enabled = setting('approvals_enabled') === '1';
  }

  state(): ApprovalsState {
    return { enabled: this.enabled, waitSec: this.waitMs / 1000, pending: [...this.pending.values()].map((p) => p.approval) };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    saveSetting('approvals_enabled', on ? '1' : '0');
    this.push({ type: 'approvals', enabled: on });
    // turning it off releases anything still waiting back to the terminal
    if (!on) for (const p of [...this.pending.values()]) p.finish('terminal');
  }

  /**
   * Hold a real PermissionRequest (or, with `ask`, an AskUserQuestion). Resolves with the JSON to
   * send back, or null for an empty 200 (= no decision, Claude Code asks in the terminal).
   */
  hold(e: OfficeEvent, detail: string, aborted?: AbortSignal, ask?: Ask): Promise<HookDecision | null> {
    return new Promise((resolve) => {
      const approval = this.add(e, detail, false, (outcome, answers) => resolve(decisionFor(outcome, ask, answers)), ask);
      // Claude Code closed the request (its hook timeout, or you answered in the terminal)
      aborted?.addEventListener('abort', () => {
        if (!this.pending.has(approval.id)) return;
        if (Date.now() - approval.ts < 3000) this.onShortHookTimeout?.(Boolean(ask));
        this.finish(approval.id, 'answered');
      });
    });
  }

  /** A demo permission request: the buttons work, nothing real is approved. */
  holdSim(e: OfficeEvent, detail: string): void {
    this.add(e, detail, true, () => {});
  }

  private add(e: OfficeEvent, detail: string, sim: boolean, resolve: (o: ApprovalOutcome, answers?: Record<string, string>) => void, ask?: Ask): Approval {
    // one open request per agent: a newer one replaces the older
    this.clearAgent(e.agentId, 'answered');
    const now = Date.now();
    const approval: Approval = { id: randomUUID(), agentId: e.agentId, tool: e.tool ?? 'tool', detail, ts: now, expiresAt: now + this.waitMs, sim, questions: ask?.questions };
    const timer = setTimeout(() => this.finish(approval.id, 'timeout'), this.waitMs);
    this.pending.set(approval.id, {
      approval,
      ask,
      finish: (outcome, answers) => {
        clearTimeout(timer);
        this.pending.delete(approval.id);
        resolve(outcome, answers);
        this.push({ type: 'approval.done', id: approval.id, outcome });
        this.onDone?.(approval, outcome, answers);
      },
    });
    this.push({ type: 'approval', approval });
    return approval;
  }

  /** The user clicked Allow / Deny / Answer in terminal. A question can only go back to the terminal or be answered. */
  decide(id: string, outcome: 'allow' | 'deny' | 'terminal'): Approval | null {
    const p = this.pending.get(id);
    if (!p || (p.ask && outcome !== 'terminal')) return null;
    p.finish(outcome);
    return p.approval;
  }

  /**
   * The user answered a held question. Options come in by index and are mapped back to the labels
   * of the original input (Claude matches on those); free text goes in as typed. 'invalid' = the
   * picks don't fit the questions, nothing is sent.
   */
  answer(id: string, picks: unknown): 'ok' | 'gone' | 'invalid' {
    const p = this.pending.get(id);
    if (!p) return 'gone';
    const raw = p.ask?.input.questions as { question: string; multiSelect?: boolean; options: { label: string }[] }[] | undefined;
    if (!raw || !Array.isArray(picks) || picks.length !== raw.length) return 'invalid';
    const answers: Record<string, string> = {};
    for (const [i, q] of raw.entries()) {
      const pick = picks[i] as Partial<Pick> | null;
      const idx = Array.isArray(pick?.picked) ? [...new Set(pick.picked)] : [];
      if (!idx.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length)) return 'invalid';
      const other = typeof pick?.other === 'string' ? pick.other.trim().slice(0, 1000) : '';
      const entries = [...idx.map((n) => q.options[n].label), ...(other ? [other] : [])];
      if (!entries.length || (!q.multiSelect && entries.length !== 1)) return 'invalid';
      answers[q.question] = entries.join(', ');
    }
    p.finish('replied', answers);
    return 'ok';
  }

  private finish(id: string, outcome: ApprovalOutcome): void {
    this.pending.get(id)?.finish(outcome);
  }

  /** The agent moved on (tool ran, turn ended, it left): whatever was open is settled. */
  clearAgent(agentId: string, outcome: ApprovalOutcome = 'answered'): void {
    for (const p of [...this.pending.values()]) if (p.approval.agentId === agentId) p.finish(outcome);
  }
}
