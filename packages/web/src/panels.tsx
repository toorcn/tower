import { displayColor } from './palette';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@tower/shared';
import { nameOf, type CollisionView, type Panel } from './derive';

const colorOf = (panel: Panel, agents: Agent[], id: string) => displayColor(agents.find(a => a.id === id)?.color ?? panel.who[id]?.color ?? '#C7C2B7');
const toolName = (tool: string) => (tool === 'claude-code' ? 'Claude Code' : tool === 'codex' ? 'Codex' : 'Simulator');

export function useNow(ms = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function Roster({ agents, panel, connected }: { agents: Agent[]; panel: Panel; connected: boolean }) {
  return (
    <aside className="panel roster">
      <header className="brand"><span>Tower<span className="brand-caption">Agent coordination</span></span><span className={`conn ${connected ? 'on' : ''}`}>{connected ? 'live' : 'reconnecting'}</span></header>
      {agents.length === 0 && <p className="empty">No agents yet.</p>}
      {agents.map(a => {
        const hold = panel.holds[a.id];
        const scope = [...panel.collisions].reverse().find(c => (c.status === 'accepted' || c.status === 'resolved') && c.agentIds.includes(a.id))?.split?.assignments.find(x => x.agentId === a.id)?.scope;
        return (
          <article key={a.id} className={`card ${hold ? 'held' : ''}`} style={{ '--c': displayColor(a.color) } as React.CSSProperties}>
            <div className="row"><i className="dot" /><b>{a.pilot}</b><span className="tool">{toolName(a.tool)}</span><span className={`status s-${hold ? 'holding' : a.status}`}>{hold ? 'On hold' : a.status}</span></div>
            {a.intent && <p className="intent">{a.intent}</p>}
            {scope && <p className="intent">Your part: {scope}</p>}
            {hold
              ? <p className="act hold">On hold: <code>{hold.path}</code> held by {nameOf(panel, hold.heldBy)}</p>
              : <p className="act"><code>{panel.activity[a.id] ?? a.status}</code></p>}
          </article>
        );
      })}
    </aside>
  );
}

export function activeCollision(panel: Panel, now: number): CollisionView | undefined {
  return [...panel.collisions].reverse().find(c => c.status === 'open' || c.status === 'proposed' || ((c.status === 'accepted' || c.status === 'resolved' || c.status === 'rejected') && now - (c.decidedAt ?? 0) < 6000));
}

export function Feed({ panel, agents, collision }: { panel: Panel; agents: Agent[]; collision?: CollisionView }) {
  const ref = useRef<HTMLDivElement>(null);
  const negotiating = collision && (collision.status === 'open' || collision.status === 'proposed');
  const size = negotiating ? collision.messages.length + (collision.split ? 1 : 0) : panel.feed.length;
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [size, negotiating, panel.feed.at(-1)?.seq]);
  if (negotiating) {
    return (
      <aside className="panel feed transcript">
        <header><span className="title">Negotiation</span><span className="badge red">{collision.agentIds.map(id => nameOf(panel, id)).join(' vs ')}</span></header>
        <div className="scroll" ref={ref}>
          <p className="sys">{collision.summary}</p>
          {collision.messages.length === 0 && <p className="sys">Delegates are reading both plans…</p>}
          {collision.messages.map(m => (
            <div key={m.seq} className="msg" style={{ '--c': colorOf(panel, agents, m.from) } as React.CSSProperties}>
              <b>{nameOf(panel, m.from)}'s delegate</b>
              <p>{m.text}</p>
            </div>
          ))}
          {collision.split && <p className="sys good">Proposed split. {collision.split.rationale}</p>}
        </div>
      </aside>
    );
  }
  return (
    <aside className="panel feed">
      <header><span className="title">Activity</span></header>
      <div className="scroll" ref={ref}>
        {panel.feed.map(f => (
          <p key={f.seq} className={`line t-${f.tone}`} style={{ '--c': colorOf(panel, agents, f.agentId) } as React.CSSProperties}><i className="dot" /><span>{f.text}</span></p>
        ))}
      </div>
    </aside>
  );
}

export function AlertCard({ collision, panel, agents }: { collision?: CollisionView; panel: Panel; agents: Agent[] }) {
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setNote(null); }, [collision?.id, collision?.status]);
  if (!collision) return null;
  const names = collision.agentIds.map(id => nameOf(panel, id));
  // Never throws: a resolved or unknown collision just shows the server's answer.
  const decide = async (verb: 'accept' | 'reject') => {
    setPending(verb); setNote(null);
    try {
      const res = await fetch(`/v1/collisions/${encodeURIComponent(collision.id)}/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) setNote(`Server answered ${res.status}. The collision may already be settled.`);
    } catch { setNote('Tower is not reachable.'); }
    finally { setPending(null); }
  };
  const done = collision.status === 'accepted' || collision.status === 'resolved' || collision.status === 'rejected';
  return (
    <section className={`panel alert-card ${done ? 'done' : ''}`} role="alert">
      <header>
        <span className="badge red">{done ? (collision.status !== 'rejected' ? 'Split accepted' : 'Split rejected') : 'Collision'}</span>
        {collision.split?.source === 'fallback' && !new URLSearchParams(window.location.search).has('presentation') && <span className="badge">fallback</span>}
        <span className="level">{collision.level === 'plan' ? 'caught at the plan' : 'caught at the edit'}</span>
      </header>
      <h2>
        <span style={{ color: colorOf(panel, agents, collision.agentIds[0]) }}>{names[0]}</span> and{' '}
        <span style={{ color: colorOf(panel, agents, collision.agentIds[1]) }}>{names[1]}</span> both need{' '}
        {collision.files.map((f, i) => <code key={f}>{i ? ', ' : ''}{f}</code>)}
      </h2>
      {done && <p className="muted">{collision.status !== 'rejected' ? `Accepted by ${collision.decidedBy}. Both agents carry on.` : `Rejected by ${collision.decidedBy}.`}</p>}
      {!done && !collision.split && <p className="muted">Delegates are negotiating a split{collision.messages.length ? ` (${collision.messages.length} messages)` : ''}…</p>}
      {!done && collision.split && (
        <>
          <ul className="assign">
            {collision.split.assignments.map(a => (
              <li key={a.agentId} style={{ '--c': colorOf(panel, agents, a.agentId) } as React.CSSProperties}>
                <i className="dot" /><b>{nameOf(panel, a.agentId)}</b> {a.scope}
                <div className="files">{a.files.map(f => <code key={f}>{f.split('/').pop()}</code>)}</div>
              </li>
            ))}
          </ul>
          <p className="muted">{collision.split.rationale}</p>
          <div className="buttons">
            <button className="accept" disabled={!!pending} onClick={() => decide('accept')}>{pending === 'accept' ? 'Sending…' : 'Accept split'}</button>
            <button className="reject" disabled={!!pending} onClick={() => decide('reject')}>Reject</button>
          </div>
        </>
      )}
      {done && collision.status !== 'rejected' && agents.filter(a => collision.agentIds.includes(a.id) && a.status === 'idle' && !panel.feed.some(f => f.seq > (collision.messages.at(-1)?.seq ?? 0) && f.text === `Told ${a.pilot} about the split`)).map(a => <p key={a.id} className="note">Type “continue” in {a.pilot}'s terminal to receive the split.</p>)}
      {note && <p className="note">{note}</p>}
    </section>
  );
}

export function Timeline({ panel }: { panel: Panel }) {
  const ticks = panel.ticks;
  if (!ticks.length) return <footer className="timeline" />;
  const t0 = ticks[0].ts, span = Math.max(90000, ticks[ticks.length - 1].ts - t0 + 5000);
  return (
    <footer className="timeline">
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 1000 24">
        <line x1="0" x2="1000" y1="12" y2="12" stroke="rgba(255,255,255,0.08)" />
        {ticks.map(t => {
          const x = ((t.ts - t0) / span) * 1000;
          const strong = t.type === 'collision.detected' ? '#D08C75' : t.type.startsWith('split.accepted') || t.type === 'collision.resolved' ? '#A5B99A' : t.type.startsWith('split') || t.type.startsWith('negotiation') ? '#FFFFFF' : null;
          return <line key={t.seq} x1={x} x2={x} y1={strong ? 2 : 8} y2={strong ? 22 : 16} stroke={strong ?? (t.type === 'file.edit' ? 'rgba(199,194,183,0.55)' : 'rgba(199,194,183,0.22)')} strokeWidth={strong ? 2.5 : 1} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
    </footer>
  );
}
