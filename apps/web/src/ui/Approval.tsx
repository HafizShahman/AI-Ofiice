import { useMemo } from 'react';
import type { Approval } from '@ai-office/shared';
import { decideApproval, setApprovals, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';
import { useNow } from './util.tsx';

export function useApprovalFor(agentId: string | undefined): Approval | undefined {
  const approvals = useOffice((s) => s.approvals);
  return useMemo(() => Object.values(approvals).find((a) => a.agentId === agentId), [approvals, agentId]);
}

/**
 * Allow / Deny for an agent's permission request (when "approve from the office" is on),
 * otherwise a pointer to the terminal plus the switch to turn it on.
 */
export function ApprovalBox({ agentId, tone = 'card' }: { agentId: string; tone?: 'card' | 'toast' }) {
  const approval = useApprovalFor(agentId);
  const on = useOffice((s) => s.approvalsOn);
  const now = useNow(1000);

  if (!approval)
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        <span>Answer it in the agent’s terminal.</span>
        {on ? (
          <span title="This request reached the office before it could be held (or came as a notification only)">Approving from the office is on.</span>
        ) : (
          <button className="text-accent hover:underline" onClick={() => void setApprovals(true)} title="Hold permission prompts so you can answer them here">
            Approve from the office…
          </button>
        )}
      </div>
    );

  const left = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  const total = Math.max(1, (approval.expiresAt - approval.ts) / 1000);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2 rounded-md border border-border bg-[#070b14] px-2 py-1.5 font-mono text-[12px]">
        <span className="shrink-0 text-warning">{approval.tool}</span>
        <span className="min-w-0 flex-1 break-all text-text">{approval.detail}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void decideApproval(approval.id, 'allow')}
          className="flex h-8 items-center gap-1.5 rounded-md bg-success px-3 text-[13px] font-medium text-[#04131a] hover:brightness-110"
        >
          <Icon name="check" strokeWidth={2.5} /> Allow
        </button>
        <button
          onClick={() => void decideApproval(approval.id, 'deny')}
          className="flex h-8 items-center gap-1.5 rounded-md border border-danger/60 px-3 text-[13px] text-danger hover:bg-danger/10"
        >
          <Icon name="x" /> Deny
        </button>
        <button
          onClick={() => void decideApproval(approval.id, 'terminal')}
          className="h-8 rounded-md px-2 text-[12px] text-muted hover:text-text"
          title="Release it now so Claude Code asks in the terminal"
        >
          Terminal
        </button>
        <span className="ml-auto font-mono text-[11px] text-muted tabular-nums" title="Then it goes back to the terminal">
          {left}s
        </span>
      </div>
      <div className="h-0.5 overflow-hidden rounded bg-border" aria-hidden="true">
        <div className="h-full bg-warning transition-[width] duration-1000 ease-linear" style={{ width: `${(left / total) * 100}%` }} />
      </div>
      {approval.sim && tone !== 'toast' && <span className="text-[11px] text-muted">Demo request: answering it changes nothing real.</span>}
    </div>
  );
}
