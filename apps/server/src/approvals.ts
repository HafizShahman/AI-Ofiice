import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalOutcome, ApprovalsState, OfficeEvent, ServerMessage } from '@ai-office/shared';
import { config } from './config.ts';
import { saveSetting, setting } from './db.ts';

/**
 * Answer permission prompts from the office (opt-in, off by default).
 *
 * When it is on, a `PermissionRequest` hook call is NOT answered at once: the server holds the
 * HTTP request open for up to `approvals.waitSec` and shows Allow / Deny in the UI. Your click
 * becomes the hook's JSON decision. If nobody clicks, you choose "answer in terminal", the
 * agent moves on, or Claude Code gives up on the hook, the request is released with an empty
 * body and Claude Code shows its normal permission prompt.
 */

export type HookDecision = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow' | 'deny'; message?: string } } };

interface Pending {
  approval: Approval;
  finish: (outcome: ApprovalOutcome) => void;
}

const decisionFor = (outcome: ApprovalOutcome): HookDecision | null =>
  outcome === 'allow'
    ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
    : outcome === 'deny'
      ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the user from AI Office.' } } }
      : null;

export class Approvals {
  enabled: boolean;
  readonly waitMs = (config.approvals?.waitSec ?? 45) * 1000;
  private pending = new Map<string, Pending>();
  private push: (m: ServerMessage) => void;
  /** told about every outcome (for the chat line) */
  onDone?: (a: Approval, outcome: ApprovalOutcome) => void;
  /** Claude Code dropped a held request within a couple of seconds: its hook timeout is too short */
  onShortHookTimeout?: () => void;

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
   * Hold a real PermissionRequest. Resolves with the JSON to send back, or null for an empty
   * 200 (= no decision, Claude Code asks in the terminal).
   */
  hold(e: OfficeEvent, detail: string, aborted?: AbortSignal): Promise<HookDecision | null> {
    return new Promise((resolve) => {
      const approval = this.add(e, detail, false, (outcome) => resolve(decisionFor(outcome)));
      // Claude Code closed the request (its hook timeout, or you answered in the terminal)
      aborted?.addEventListener('abort', () => {
        if (!this.pending.has(approval.id)) return;
        if (Date.now() - approval.ts < 3000) this.onShortHookTimeout?.();
        this.finish(approval.id, 'answered');
      });
    });
  }

  /** A demo permission request: the buttons work, nothing real is approved. */
  holdSim(e: OfficeEvent, detail: string): void {
    this.add(e, detail, true, () => {});
  }

  private add(e: OfficeEvent, detail: string, sim: boolean, resolve: (o: ApprovalOutcome) => void): Approval {
    // one open request per agent: a newer one replaces the older
    this.clearAgent(e.agentId, 'answered');
    const now = Date.now();
    const approval: Approval = { id: randomUUID(), agentId: e.agentId, tool: e.tool ?? 'tool', detail, ts: now, expiresAt: now + this.waitMs, sim };
    const timer = setTimeout(() => this.finish(approval.id, 'timeout'), this.waitMs);
    this.pending.set(approval.id, {
      approval,
      finish: (outcome) => {
        clearTimeout(timer);
        this.pending.delete(approval.id);
        resolve(outcome);
        this.push({ type: 'approval.done', id: approval.id, outcome });
        this.onDone?.(approval, outcome);
      },
    });
    this.push({ type: 'approval', approval });
    return approval;
  }

  /** The user clicked Allow / Deny / Answer in terminal. */
  decide(id: string, outcome: 'allow' | 'deny' | 'terminal'): Approval | null {
    const p = this.pending.get(id);
    if (!p) return null;
    p.finish(outcome);
    return p.approval;
  }

  private finish(id: string, outcome: ApprovalOutcome): void {
    this.pending.get(id)?.finish(outcome);
  }

  /** The agent moved on (tool ran, turn ended, it left): whatever was open is settled. */
  clearAgent(agentId: string, outcome: ApprovalOutcome = 'answered'): void {
    for (const p of [...this.pending.values()]) if (p.approval.agentId === agentId) p.finish(outcome);
  }
}
