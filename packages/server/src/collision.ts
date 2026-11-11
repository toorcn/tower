import type { TowerState } from '../../shared/src/index.js';
export function collisions(state: TowerState) {
  const pairs = new Map<string, { agentIds: [string, string]; files: string[]; level: 'plan' | 'edit' }>();
  const claims = state.claims.filter(c => c.mode !== 'reading' && state.agents.some(a => a.id === c.agentId));
  for (let i = 0; i < claims.length; i++) for (const b of claims.slice(i + 1)) {
    const a = claims[i];
    if (a.path !== b.path || a.agentId === b.agentId) continue;
    if (state.agents.find(x => x.id === a.agentId)?.repoId !== state.agents.find(x => x.id === b.agentId)?.repoId) continue;
    if (state.collisions.some(c => c.events.some(e => e.type === 'collision.detected' && e.data.agentIds.includes(a.agentId) && e.data.agentIds.includes(b.agentId)) && c.events.some(e => e.type === 'split.accepted') && c.events.some(e => e.type === 'split.proposed' && e.data.assignments.some(x => x.files.includes(a.path) && [a.agentId, b.agentId].includes(x.agentId))))) continue;
    const agentIds = [a.agentId, b.agentId].sort() as [string, string];
    const key = JSON.stringify(agentIds);
    const pair = pairs.get(key) ?? { agentIds, files: [], level: 'edit' as 'plan' | 'edit' };
    pair.files.push(a.path); if (a.mode === 'planned' || b.mode === 'planned') pair.level = 'plan';
    pairs.set(key, pair);
  }
  return [...pairs.values()].map(p => ({ ...p, files: [...new Set(p.files)].sort() }));
}
