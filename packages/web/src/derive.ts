import type { TowerEvent } from '@tower/shared';

/** Panel-side view of the run, rebuilt from every event (including the replay after a reload). */
export interface Who { pilot: string; color: string; tool: string }
export interface FeedItem { seq: number; agentId: string; text: string; tone: 'normal' | 'edit' | 'alert' | 'good' }
export interface CollisionView {
  id: string; agentIds: [string, string]; files: string[]; level: 'plan' | 'edit'; summary: string;
  messages: { seq: number; from: string; text: string }[];
  split: { assignments: { agentId: string; scope: string; files: string[] }[]; rationale: string; source: 'model' | 'fallback' } | null;
  status: 'open' | 'proposed' | 'accepted' | 'rejected' | 'resolved';
  decidedBy?: string; decidedAt?: number;
}
export interface Panel {
  who: Record<string, Who>;
  activity: Record<string, string>;
  holds: Record<string, { path: string; heldBy: string }>;
  collisions: CollisionView[];
  feed: FeedItem[];
  ticks: { seq: number; ts: number; type: string }[];
}

export const emptyPanel = (): Panel => ({ who: {}, activity: {}, holds: {}, collisions: [], feed: [], ticks: [] });

const base = (p: string) => p.split('/').pop() ?? p;
export const nameOf = (panel: Panel, id: string) => (id === 'system' ? 'Tower' : panel.who[id]?.pilot ?? id);

export function describe(panel: Panel, e: TowerEvent): { text: string; tone: FeedItem['tone'] } | null {
  const who = nameOf(panel, e.agentId);
  switch (e.type) {
    case 'agent.joined': return { text: `${e.data.agent.pilot} joined with ${e.data.agent.tool}`, tone: 'normal' };
    case 'agent.left': return { text: `${who} left`, tone: 'normal' };
    case 'agent.status': return e.data.status === 'idle' ? { text: `${who} is idle`, tone: 'normal' } : null;
    case 'intent.declared': return { text: e.data.predictedFiles.length ? `${who} plans to touch ${e.data.predictedFiles.map(base).join(', ')}` : `${who}: "${e.data.text}"`, tone: 'normal' };
    case 'file.read': return { text: `${who} read ${e.data.path}`, tone: 'normal' };
    case 'file.search': return { text: `${who} searched "${e.data.query}"${e.data.scope ? ` in ${e.data.scope}` : ''}`, tone: 'normal' };
    case 'file.edit': return { text: `${who} ${e.data.op === 'create' ? 'created' : e.data.op === 'delete' ? 'deleted' : 'edited'} ${e.data.path}`, tone: 'edit' };
    case 'command.run': return { text: `${who} ran ${e.data.command}`, tone: 'normal' };
    case 'command.done': return { text: `${who}: ${e.data.kind === 'test' ? 'tests' : e.data.kind} ${e.data.exitCode === 0 ? 'passed' : `failed (exit ${e.data.exitCode})`}`, tone: e.data.exitCode === 0 ? 'good' : 'alert' };
    case 'hold.applied': return { text: `Edit to ${e.data.path} put on hold. ${nameOf(panel, e.data.heldBy)} holds it.`, tone: 'alert' };
    case 'collision.detected': return { text: `Collision: ${e.data.agentIds.map(id => nameOf(panel, id)).join(' and ')} on ${e.data.files.map(base).join(', ')}`, tone: 'alert' };
    case 'negotiation.message': return { text: `${nameOf(panel, e.data.from)}'s delegate: ${e.data.text}`, tone: 'normal' };
    case 'split.proposed': return { text: `Split proposed: ${e.data.rationale}`, tone: 'normal' };
    case 'split.accepted': return { text: `Split accepted by ${e.data.by}`, tone: 'good' };
    case 'split.rejected': return { text: `Split rejected by ${e.data.by}`, tone: 'alert' };
    case 'collision.resolved': return { text: 'Collision resolved', tone: 'good' };
    case 'mail.delivered': return { text: `Told ${nameOf(panel, e.data.to)} about the ${e.data.kind}`, tone: 'normal' };
  }
}

function action(e: TowerEvent): string | null {
  switch (e.type) {
    case 'file.read': return `reading ${e.data.path}`;
    case 'file.search': return `searching "${e.data.query}"`;
    case 'file.edit': return `${e.data.op === 'create' ? 'creating' : e.data.op === 'delete' ? 'deleting' : 'editing'} ${e.data.path}`;
    case 'command.run': return `running ${e.data.command}`;
    case 'command.done': return e.data.exitCode === 0 ? `${e.data.kind === 'test' ? 'tests' : e.data.kind} passed` : `${e.data.kind} failed`;
    case 'intent.declared': return 'planning';
    case 'agent.status': return e.data.status === 'idle' ? 'idle' : e.data.status === 'thinking' ? 'thinking' : null;
    case 'agent.joined': return 'thinking';
    default: return null;
  }
}

export function derive(panel: Panel, e: TowerEvent): Panel {
  const next: Panel = { ...panel, ticks: [...panel.ticks, { seq: e.seq, ts: e.ts, type: e.type }].slice(-800) };
  if (e.type === 'agent.joined') next.who = { ...panel.who, [e.agentId]: { pilot: e.data.agent.pilot, color: e.data.agent.color, tool: e.data.agent.tool } };
  const act = action(e);
  if (act && e.agentId !== 'system') next.activity = { ...panel.activity, [e.agentId]: act };
  const editCol = (id: string, f: (c: CollisionView) => CollisionView) => { next.collisions = next.collisions.map(c => (c.id === id ? f(c) : c)); };
  const releaseHolds = (c?: CollisionView) => { if (c) { const h = { ...next.holds }; for (const id of c.agentIds) delete h[id]; next.holds = h; } };
  switch (e.type) {
    case 'agent.status':
      if (e.data.status === 'working' || e.data.status === 'idle') { const h = { ...next.holds }; delete h[e.agentId]; next.holds = h; }
      break;
    case 'hold.applied': {
      const c = next.collisions.find(x => x.id === e.data.collisionId);
      const held = c?.agentIds.find(id => id !== e.data.heldBy);
      if (held) next.holds = { ...next.holds, [held]: { path: e.data.path, heldBy: e.data.heldBy } };
      break;
    }
    case 'collision.detected': {
      const existing = panel.collisions.find(c => c.id === e.data.collisionId);
      next.collisions = [...next.collisions.filter(c => c.id !== e.data.collisionId), { id: e.data.collisionId, agentIds: e.data.agentIds, files: e.data.files, level: e.data.level, summary: e.data.summary, messages: existing?.messages ?? [], split: existing?.split ?? null, status: existing?.status ?? 'open' }];
      break;
    }
    case 'negotiation.message': editCol(e.data.collisionId, c => ({ ...c, messages: [...c.messages, { seq: e.seq, from: e.data.from, text: e.data.text }] })); break;
    case 'split.proposed': editCol(e.data.collisionId, c => ({ ...c, status: 'proposed', split: { assignments: e.data.assignments, rationale: e.data.rationale, source: e.data.source } })); break;
    case 'split.accepted': editCol(e.data.collisionId, c => ({ ...c, status: 'accepted', decidedBy: e.data.by, decidedAt: e.ts })); releaseHolds(next.collisions.find(c => c.id === e.data.collisionId)); break;
    case 'split.rejected': editCol(e.data.collisionId, c => ({ ...c, status: 'rejected', decidedBy: e.data.by, decidedAt: e.ts })); break;
    case 'collision.resolved': editCol(e.data.collisionId, c => ({ ...c, status: 'resolved', decidedAt: c.decidedAt ?? e.ts })); releaseHolds(next.collisions.find(c => c.id === e.data.collisionId)); break;
  }
  const line = describe(next, e);
  if (line) next.feed = [...panel.feed, { seq: e.seq, agentId: e.type === 'negotiation.message' ? e.data.from : e.agentId, ...line }].slice(-120);
  return next;
}
