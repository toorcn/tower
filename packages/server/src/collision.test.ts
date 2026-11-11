import { describe, it, expect } from 'vitest';
import { claim, expire, priority, updateClaims } from './claims.js';
import { collisions } from './collision.js';
import { predict } from './prediction.js';
import { hookResponse } from './hook-response.js';
import { initialState, type Claim } from '../../shared/src/index.js';
const a: Claim = { agentId: 'a', path: 'src/auth/session.ts', mode: 'planned', ts: 1 };
const b: Claim = { ...a, agentId: 'b', mode: 'editing', ts: 2 };
describe('collision primitives', () => {
  it('upgrades, preserves editing, expires and drops leaving claims', () => {
    expect(claim([a], { ...a, mode: 'editing' })[0].mode).toBe('editing');
    expect(claim([b], { ...b, mode: 'reading' })[0].mode).toBe('editing');
    expect(expire([a, { ...b, mode: 'reading' }], 120003)).toEqual([a]);
    expect(expire([a], 900001)).toEqual([]);
    expect(updateClaims([a,b], { seq: 1, ts: 3, agentId: 'a', type: 'agent.left', data: {} })).toEqual([b]);
  });
  it('replaces planned while keeping editing', () => {
    expect(updateClaims([a,b], { seq: 1, ts: 3, agentId: 'a', type: 'intent.declared', data: { text: 'new', predictedFiles: ['new.ts'] } }).map(c => c.path)).toEqual([b.path, 'new.ts']);
  });
  it('uses mode then age for priority', () => { expect(priority(a,b)).toEqual(b); expect(priority(a,{...b,mode:'planned'})).toEqual(a); });
  it('groups files by pair and ignores reads', () => {
    const state = initialState();
    state.agents = ['a','b'].map(id => ({ id, repoId:'demo', pilot:id, tool:'sim', color:'', branch:'', worktree:'/tmp', status:'working', joinedAt:0,lastSeen:0 }));
    state.claims = [a,b]; expect(collisions(state)[0].level).toBe('plan');
    state.claims = [{...a,mode:'reading'},b]; expect(collisions(state)).toEqual([]);
    state.claims = [a,b,{...a,path:'two'},{...b,path:'two'}]; expect(collisions(state)).toHaveLength(1); expect(collisions(state)[0].files).toHaveLength(2);
  });
  it('predicts session expiry', () => { expect(predict('add session expiry to authentication', [a.path,'src/settings/theme.ts']).files).toContain(a.path); });
  it.each(['claude-code','codex'])('constructs allow, deny, warn and guarded stop for %s', () => {
    expect(hookResponse('PreToolUse', []).response).toEqual({});
    const mail = [{kind:'collision' as const,text:'Someone is waiting'}];
    expect(JSON.stringify(hookResponse('PreToolUse',mail,'held').response)).toContain('permissionDecisionReason');
    expect(JSON.stringify(hookResponse('PreToolUse',mail,'held','warn').response)).not.toContain('deny');
    expect(hookResponse('Stop',mail).response).toEqual({decision:'block',reason:mail[0].text});
    expect(hookResponse('Stop',mail,'','hold',true).delivered).toEqual([]);
  });
});

it('excludes only the accepted pair and enforces split ownership', async () => {
  const { heldFiles } = await import('./holds.js');
  const state = initialState();
  state.agents = ['a','b','c'].map(id => ({ id, repoId:'demo', pilot:id, tool:'sim', color:'', branch:'', worktree:'/tmp', status:'working', joinedAt:0,lastSeen:0 }));
  state.claims = [a,b,{...b,agentId:'c'}];
  state.collisions = [{ collisionId:'split',events:[
    {seq:1,ts:1,agentId:'system',type:'collision.detected',data:{collisionId:'split',agentIds:['a','b'],files:[a.path],level:'plan',summary:'overlap'}},
    {seq:2,ts:2,agentId:'system',type:'split.proposed',data:{collisionId:'split',assignments:[{agentId:'a',scope:'auth',files:[a.path]}],rationale:'a owns auth',source:'fallback'}},
    {seq:3,ts:3,agentId:'system',type:'split.accepted',data:{collisionId:'split',by:'test'}},
  ] }];
  expect(collisions(state).map(c => c.agentIds)).toEqual([['a','c'],['b','c']]);
  expect(heldFiles(state,'b',[a.path])[0].reason).toContain('accepted split');
  expect(heldFiles(state,'a',[a.path])).toEqual([]);
});
