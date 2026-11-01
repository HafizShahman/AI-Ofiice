import { useMemo, useState } from 'react';
import type { Approval } from '@ai-office/shared';
import { answerQuestions, decideApproval, setApprovals, useOffice } from '../store.ts';
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

  if (approval.questions) return <QuestionBox key={approval.id} approval={approval} />;

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

interface Pick {
  picked: number[];
  other: string;
}

/**
 * An AskUserQuestion held for an answer: each question's options as buttons (radio-style, or
 * checkboxes when several may be chosen) plus a field for your own answer. One question with one
 * choice is sent as soon as you click it; otherwise "Send answer" waits until every question has one.
 */
function QuestionBox({ approval }: { approval: Approval }) {
  const questions = approval.questions!;
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ picked: [], other: '' })));
  const [sent, setSent] = useState(false);
  const now = useNow(1000);

  const send = (p: Pick[]) => {
    setSent(true);
    void answerQuestions(approval.id, p.map((x) => ({ picked: x.picked, other: x.other.trim() || undefined })));
  };
  const update = (qi: number, f: (p: Pick) => Pick) => setPicks((all) => all.map((p, i) => (i === qi ? f(p) : p)));
  const ready = picks.every((p) => p.picked.length > 0 || p.other.trim());
  const quick = questions.length === 1 && !questions[0].multiSelect;

  const pickOption = (qi: number, oi: number) => {
    const q = questions[qi];
    if (quick) return send([{ picked: [oi], other: '' }]);
    update(qi, (p) =>
      q.multiSelect
        ? { ...p, picked: p.picked.includes(oi) ? p.picked.filter((x) => x !== oi) : [...p.picked, oi] }
        : { picked: p.picked.includes(oi) ? [] : [oi], other: '' }, // one choice: an option replaces your own text
    );
  };

  const left = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  const total = Math.max(1, (approval.expiresAt - approval.ts) / 1000);
  return (
    <div className={`flex flex-col gap-3 ${sent ? 'pointer-events-none opacity-60' : ''}`}>
      {questions.map((q, qi) => (
        <fieldset key={qi} className="flex flex-col gap-1.5">
          <legend className="mb-1 flex flex-wrap items-center gap-2">
            {q.header && <span className="rounded border border-border px-1.5 font-mono text-[10px] uppercase tracking-wide text-muted">{q.header}</span>}
            {q.multiSelect && <span className="text-[11px] text-muted">choose any</span>}
          </legend>
          <div className="whitespace-pre-line text-[13px] leading-snug text-text">{q.question}</div>
          <div role={q.multiSelect ? 'group' : 'radiogroup'} className="flex flex-col gap-1">
            {q.options.map((o, oi) => {
              const on = picks[qi].picked.includes(oi);
              return (
                <button
                  key={oi}
                  type="button"
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  onClick={() => pickOption(qi, oi)}
                  className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    on ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/60 hover:bg-surface-2'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-[3px] grid size-3.5 shrink-0 place-items-center border ${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'} ${on ? 'border-accent bg-accent text-[#04131a]' : 'border-muted'}`}
                  >
                    {on && <Icon name="check" size={10} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-text">{o.label}</span>
                    {o.description && <span className="block text-[12px] leading-snug text-muted">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              type="text"
              value={picks[qi].other}
              maxLength={1000}
              placeholder="Or type your own answer…"
              aria-label={`Your own answer to: ${q.question}`}
              onChange={(e) => update(qi, (p) => ({ picked: q.multiSelect ? p.picked : e.target.value ? [] : p.picked, other: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready) send(picks);
              }}
              className="h-8 w-full rounded-md border border-border bg-[#070b14] px-2.5 text-[13px] text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </fieldset>
      ))}
      <div className="flex items-center gap-1.5">
        {!quick && (
          <button
            onClick={() => send(picks)}
            disabled={!ready}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-[#04131a] hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
          >
            <Icon name="check" strokeWidth={2.5} /> Send answer
          </button>
        )}
        {quick && picks[0].other.trim() && (
          <button onClick={() => send(picks)} className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-[#04131a] hover:brightness-110">
            <Icon name="check" strokeWidth={2.5} /> Send answer
          </button>
        )}
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
      {approval.sim && <span className="text-[11px] text-muted">Demo question: answering it changes nothing real.</span>}
    </div>
  );
}
