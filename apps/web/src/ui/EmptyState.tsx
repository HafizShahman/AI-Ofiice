import { useState } from 'react';
import { toggleSim, useOffice } from '../store.ts';
import { Icon } from './icons.tsx';

/** First-run card over the empty office (design: docs/design/screens/4-first-run.jpg). */
export function EmptyState() {
  const empty = useOffice((s) => Object.keys(s.agents).length === 0);
  const sim = useOffice((s) => s.sim);
  const connection = useOffice((s) => s.connection);
  const events = useOffice((s) => s.events.length);
  const [copied, setCopied] = useState(false);
  if (!empty || sim || events > 0) return null;

  const cmd = `npm run install-hooks -- --url ${location.protocol}//${location.hostname}:3334/hook`;
  return (
    <div data-ui className="absolute inset-0 grid place-items-center bg-[#070b14]/55 p-6">
      <section aria-labelledby="setup-title" className="flex w-full max-w-[520px] flex-col gap-5 rounded-[14px] border border-border bg-surface p-7 shadow-[0_16px_48px_rgb(0_0_0/.55)]">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] tracking-[0.1em] text-accent">SETUP</span>
          <h1 id="setup-title" className="m-0 text-[22px] font-semibold">
            Connect Claude Code to the office
          </h1>
          <p className="m-0 text-[14px] leading-normal text-muted">Robots appear as soon as the office receives its first hook event. Nothing leaves your machine.</p>
        </div>
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          <Step n={1} done={connection === 'open'} title="Office server running" sub={connection === 'open' ? `${location.host} · connected` : 'waiting for the server…'} />
          <li className="flex gap-3 rounded-[10px] border border-accent/40 bg-surface-2 p-3">
            <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-accent font-mono text-[12px] font-semibold text-[#04131a]">2</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="font-semibold">Install the hooks</span>
              <span className="text-[13px] leading-normal text-muted">
                Adds HTTP hooks to <span className="font-mono text-text">~/.claude/settings.json</span> and keeps a backup.
              </span>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg py-2 pl-3 pr-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-[#67e8f9]">{cmd}</code>
                <button
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-[12px]"
                  onClick={() => navigator.clipboard?.writeText(cmd).then(() => setCopied(true))}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </li>
          <Step n={3} title="Start any Claude Code session" sub="Waiting for the first event…" pulse />
        </ol>
        <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-4">
          <button
            onClick={() => toggleSim(true)}
            className="flex h-10 items-center gap-2 rounded-lg border border-accent-2/50 bg-accent-2/10 px-4 text-[14px] font-medium text-[#f0abfc]"
          >
            <Icon name="play" /> Try demo (sim)
          </button>
          <span className="ml-auto text-[12px] text-muted">Robot: “Mini Robot” by Onur, CC BY 4.0</span>
        </div>
      </section>
    </div>
  );
}

function Step({ n, title, sub, done, pulse }: { n: number; title: string; sub: string; done?: boolean; pulse?: boolean }) {
  return (
    <li className="flex gap-3 rounded-[10px] p-3">
      {done ? (
        <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-success/15 text-success">
          <Icon name="check" strokeWidth={2.5} />
        </span>
      ) : (
        <span className="box-border grid size-[26px] shrink-0 place-items-center rounded-full border-[1.5px] border-[#2b3b5c] font-mono text-[12px] text-muted">{n}</span>
      )}
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="flex items-center gap-2 font-mono text-[12px] text-muted">
          {pulse && <span className="size-1.5 animate-[pulse-dot_1.6s_infinite] rounded-full bg-accent" />}
          {sub}
        </span>
      </div>
    </li>
  );
}
