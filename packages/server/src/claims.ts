import type { Claim, TowerEvent } from '../../shared/src/index.js';
const rank = { reading: 0, planned: 1, editing: 2 };
export function claim(claims: Claim[], next: Claim): Claim[] {
  const old = claims.find(c => c.agentId === next.agentId && c.path === next.path);
  const mode = old && rank[old.mode] > rank[next.mode] ? old.mode : next.mode;
  const acquiredAt = old?.mode === mode ? old.acquiredAt ?? old.ts : next.ts;
  return [...claims.filter(c => c !== old), { ...next, acquiredAt, mode }];
}
export function expire(claims: Claim[], now: number): Claim[] { return claims.filter(c => now - c.ts < (c.mode === 'reading' ? 120000 : 900000)); }
export function updateClaims(claims: Claim[], e: TowerEvent): Claim[] {
  if (e.type === 'agent.left') return claims.filter(c => c.agentId !== e.agentId);
  if (e.type === 'intent.declared' && e.data.predictedFiles.length) {
    claims = replacePlanned(claims, e.agentId, e.data.predictedFiles, e.ts);
  }
  if (e.type === 'file.read' || e.type === 'file.edit') claims = claim(claims, { agentId: e.agentId, path: e.data.path, mode: e.type === 'file.read' ? 'reading' : 'editing', ts: e.ts });
  return claims;
}
export function priority(a: Claim, b: Claim): Claim { return rank[a.mode] !== rank[b.mode] ? (rank[a.mode] > rank[b.mode] ? a : b) : (a.acquiredAt ?? a.ts) !== (b.acquiredAt ?? b.ts) ? ((a.acquiredAt ?? a.ts) < (b.acquiredAt ?? b.ts) ? a : b) : (a.agentId < b.agentId ? a : b); }

export function replacePlanned(claims: Claim[], agentId: string, paths: string[], ts: number): Claim[] {
  let next = claims.filter(c => c.agentId !== agentId || c.mode !== 'planned');
  for (const path of paths) next = claim(next, { agentId, path, mode: 'planned', ts });
  return next;
}
