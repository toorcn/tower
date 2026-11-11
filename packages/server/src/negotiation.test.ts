import { describe, it, expect } from 'vitest';
import { fallbackSplit, validateSplit } from './negotiation.js';
import { initialState } from '../../shared/src/index.js';
describe('split', () => {
  const good = { assignments: [{agentId:'a', scope:'a', files:['x']}, {agentId:'b',scope:'b',files:['y']}], rationale:'division' };
  it('validates exact ownership', () => {
    expect(validateSplit(good,['a','b'],['x','y'])).toEqual(good);
    for (const assignments of [good.assignments.slice(0,1), [{...good.assignments[0],files:[]},good.assignments[1]], [good.assignments[0],{...good.assignments[1],files:['x','y']}], [{...good.assignments[0],agentId:'z'},good.assignments[1]]]) expect(() => validateSplit({...good,assignments},['a','b'],['x','y'])).toThrow();
  });
  it('prefers editing then older claims', () => {
    const state = initialState();
    state.claims = [{agentId:'a',path:'x',mode:'planned',ts:1},{agentId:'b',path:'x',mode:'editing',ts:2},{agentId:'a',path:'y',mode:'planned',ts:1},{agentId:'b',path:'y',mode:'planned',ts:2}];
    expect(fallbackSplit(state,['a','b'],['x','y']).assignments.map(a => a.files)).toEqual([['y'],['x']]);
  });
});

import { vi } from 'vitest';
import { createServer } from './index.js';
import { delegateContext, modelNegotiation } from './negotiation.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('isolates delegate context and falls back after a timed out second turn', async () => {
 const state=initialState();
 state.agents=['a','b'].map(id=>({id,pilot:id,tool:'sim' as const,color:'',repoId:'r',worktree:'/tmp',branch:id,status:'working' as const,joinedAt:0,lastSeen:0,intent:id}));
 state.claims=[{agentId:'a',path:'private-a',mode:'editing',ts:1},{agentId:'b',path:'private-b',mode:'editing',ts:1}];
 expect(JSON.stringify(delegateContext(state,['a','b'],['shared'],'a',[],false))).not.toContain('private-b');
 let turns=0;
 await expect(modelNegotiation(state,['a','b'],['shared'],'a',false,async()=>{ if(++turns===1)return 'I take shared.';return new Promise(()=>{}); },{callMs:10})).rejects.toThrow('timeout');
});
it('runs fallback, retries once, accepts with claims and mail, and is idempotent', async () => {
 const key=process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_API_KEY;
 const {app}=await createServer({logDir:mkdtempSync(join(tmpdir(),'tower-neg-'))});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,payload:payload as any});
 try {
 for(const id of ['a','b']) await post('/v1/events',{agentId:id,type:'agent.joined',data:{agent:{id,pilot:id,tool:'sim',color:'',repoId:'demo',worktree:'/tmp/demo',branch:id,status:'working',joinedAt:0,lastSeen:0}}});
 for(const id of ['a','b']) await post('/v1/events',{agentId:id,type:'intent.declared',data:{text:id,predictedFiles:['x']}});
 await vi.advanceTimersByTimeAsync(7000);
 let s=(await app.inject('/v1/state')).json();const id=s.collisions[0].collisionId;
 expect(s.recentEvents.filter((e:any)=>e.type==='negotiation.message')).toHaveLength(4);
 await post(`/v1/collisions/${id}/reject`,{});await vi.advanceTimersByTimeAsync(7000);
 s=(await app.inject('/v1/state')).json();expect(s.collisions[0].events.filter((e:any)=>e.type==='split.proposed')).toHaveLength(2);
 await post(`/v1/collisions/${id}/reject`,{});await vi.advanceTimersByTimeAsync(7000);
 s=(await app.inject('/v1/state')).json();expect(s.collisions[0].events.filter((e:any)=>e.type==='split.proposed')).toHaveLength(2);
 expect((await post(`/v1/collisions/${id}/accept`,{})).statusCode).toBe(409);
 // New run for accept.
 await post('/v1/admin/reset',{});
 for(const agentId of ['a','b']) { await post('/v1/events',{agentId,type:'agent.joined',data:{agent:{id:agentId,pilot:agentId,tool:'sim',color:'',repoId:'demo',worktree:'/tmp/demo',branch:agentId,status:'working',joinedAt:0,lastSeen:0}}});await post('/v1/events',{agentId,type:'intent.declared',data:{text:agentId,predictedFiles:['x']}}); }
 await vi.advanceTimersByTimeAsync(7000);s=(await app.inject('/v1/state')).json();const next=s.collisions[0].collisionId;
 expect((await post(`/v1/collisions/${next}/accept`,{})).statusCode).toBe(200);
 s=(await app.inject('/v1/state')).json();const seq=s.lastSeq;
 expect(s.claims).toHaveLength(1);expect(s.recentEvents.slice(-2).map((e:any)=>e.type)).toEqual(['split.accepted','collision.resolved']);
 await post(`/v1/collisions/${next}/accept`,{});expect((await app.inject('/v1/state')).json().lastSeq).toBe(seq);
 } finally {vi.useRealTimers();await app.close();if(key)process.env.ANTHROPIC_API_KEY=key;}
});
it('server uses fallback when model turn two times out, and auto accepts in five seconds', async () => {
 const old=process.env.TOWER_AUTO_ACCEPT;process.env.TOWER_AUTO_ACCEPT='5';let calls=0;
 const {app}=await createServer({logDir:mkdtempSync(join(tmpdir(),'tower-model-')),modelCall:async()=>{if(++calls===1)return 'I take x.';return new Promise(()=>{});}});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
 try {
 for(const agentId of ['a','b']) {
 await app.inject({method:'POST',url:'/v1/events',payload:{agentId,type:'agent.joined',data:{agent:{id:agentId,pilot:agentId,tool:'sim',color:'',repoId:'demo',worktree:'/tmp/demo',branch:agentId,status:'working',joinedAt:0,lastSeen:0}}}});
 await app.inject({method:'POST',url:'/v1/events',payload:{agentId,type:'intent.declared',data:{text:agentId,predictedFiles:['x']}}});
 }
 await vi.advanceTimersByTimeAsync(10000);
 let s=(await app.inject('/v1/state')).json();expect(s.recentEvents.find((e:any)=>e.type==='split.proposed').data.source).toBe('fallback');
 expect(s.recentEvents.some((e:any)=>e.type==='split.accepted')).toBe(false);
 await vi.advanceTimersByTimeAsync(5000);s=(await app.inject('/v1/state')).json();expect(s.recentEvents.some((e:any)=>e.type==='collision.resolved')).toBe(true);
 }finally{vi.useRealTimers();await app.close();if(old===undefined)delete process.env.TOWER_AUTO_ACCEPT;else process.env.TOWER_AUTO_ACCEPT=old;}
});
it('model path alternates isolated delegates and validates its extraction', async () => {
 const state=initialState();state.agents=['a','b'].map(id=>({id,pilot:id,tool:'sim' as const,color:'',repoId:'r',worktree:'/tmp',branch:id,status:'working' as const,joinedAt:0,lastSeen:0,intent:id}));
 state.claims=[{agentId:'a',path:'private-a',mode:'editing',ts:1},{agentId:'b',path:'private-b',mode:'editing',ts:1}];
 const inputs: any[]=[];
 const result=await modelNegotiation(state,['a','b'],['x'],'b',true,async(_system,data)=>{inputs.push(data);if(inputs.length===1)return 'I take x.';if(inputs.length===2)return 'Agreed, you take x.';return JSON.stringify({assignments:[{agentId:'a',scope:'outside x',files:[]},{agentId:'b',scope:'x',files:['x']}],rationale:'Agreed ownership'});});
 expect(result.lines.map(l=>l.from)).toEqual(['b','a']);expect(JSON.stringify(inputs[0])).not.toContain('private-a');expect(JSON.stringify(inputs[1])).not.toContain('private-b');expect(inputs[0].shared.instruction).toContain('rejected');
});

it('keeps accepted split mail across SessionEnd and delivers once on the next prompt', async () => {
 const key=process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_API_KEY;
 const {app}=await createServer({logDir:mkdtempSync(join(tmpdir(),'tower-resume-'))});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
 const worktree=process.cwd();
 const hook=(event:string)=>app.inject({method:'POST',url:'/v1/hook',payload:{tool:'codex',pilot:'Sarah',branch:'test',worktree,payload:{session_id:'resume-mail',cwd:worktree,hook_event_name:event,...(event==='UserPromptSubmit'?{prompt:'continue'}:{})}}});
 try {
 await hook('SessionStart');
 const ids=['codex:resume-mail','other'];
 await app.inject({method:'POST',url:'/v1/events',payload:{agentId:'other',type:'agent.joined',data:{agent:{id:'other',pilot:'Hong',tool:'sim',color:'',repoId:'tower',worktree,branch:'test',status:'working',joinedAt:0,lastSeen:0}}}});
 for(const agentId of ids)await app.inject({method:'POST',url:'/v1/events',payload:{agentId,type:'intent.declared',data:{text:'task',predictedFiles:['x']}}});
 await vi.advanceTimersByTimeAsync(7000);
 const state=(await app.inject('/v1/state')).json();
 await app.inject({method:'POST',url:`/v1/collisions/${state.collisions[0].collisionId}/accept`,payload:{}});
 await hook('SessionEnd');
 expect((await hook('UserPromptSubmit')).json().hookSpecificOutput.additionalContext).toContain('split agreed');
 expect((await hook('UserPromptSubmit')).json()).toEqual({});
 const events=(await app.inject('/v1/state')).json().recentEvents;
 expect(events.filter((e:any)=>e.type==='mail.delivered'&&e.data.kind==='split'&&e.data.to===ids[0])).toHaveLength(1);
 }finally{vi.useRealTimers();await app.close();if(key)process.env.ANTHROPIC_API_KEY=key;}
});
