import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './index.js';
import { HookPayloadSchema, type TowerState } from '../../shared/src/index.js';
import { editPaths } from './holds.js';
import { claim, priority } from './claims.js';
import { parsePrediction, predictTask } from './prediction.js';

it('refreshes expiry without transferring older priority', () => {
  const first = { agentId: 'a', path: 'x', mode: 'editing' as const, ts: 1 };
  const refreshed = claim([first], { ...first, ts: 10 })[0];
  const upgraded = claim([{ ...first, mode: 'planned' }], { ...first, ts: 10 })[0];
  expect(priority(upgraded, { ...first, agentId: 'b', ts: 5 }).agentId).toBe('b');
  expect(refreshed.ts).toBe(10);
  expect(priority(refreshed, { ...first, agentId: 'b', ts: 5 }).agentId).toBe('a');
});
it('filters model paths and falls back on bad JSON, failure, and timeout', async () => {
  const paths = ['src/auth/session.ts'];
  expect(parsePrediction({ summary: 'x'.repeat(100), files: [...paths, 'outside', ...paths] }, paths)).toEqual({ summary: 'x'.repeat(80), files: paths });
  for (const fetcher of [async () => new Response('bad'), async () => { throw Error(); }, () => new Promise<Response>(() => {})]) {
    expect((await predictTask('add session expiry now', paths, { key: 'test', fetch: fetcher as typeof fetch, timeoutMs: 10 })).files).toEqual(paths);
  }
});
it.each(['hold', 'warn', 'off'])('enforces fixture patches and delivers mail once in %s mode', async enforce => {
  vi.stubEnv('TOWER_ENFORCE', enforce);
  const logDir = mkdtempSync(join(tmpdir(), 'tower-holds-'));
  const { app } = await createServer({ logDir });
  const repo = process.cwd();
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const hook = (tool: string, payload: object) => post('/v1/hook', { tool, pilot: tool, branch: '', worktree: repo, payload: { session_id: tool, cwd: repo, ...payload } });
  try {
    for (const tool of ['claude-code', 'codex']) await hook(tool, { hook_event_name: 'SessionStart' });
    // Real captured pre-edit tool shapes, with only cwd and file roots relocated.
    const fixtures = (tool: string) => readdirSync(`fixtures/raw/${tool}`).filter(f => f.startsWith('PreToolUse')).map(f => JSON.parse(readFileSync(`fixtures/raw/${tool}/${f}`, 'utf8')));
    const claude = fixtures('claude-code').find(f => f.tool_name === 'Edit');
    const codex = fixtures('codex').find(f => f.tool_name === 'apply_patch' && f.tool_input.command.includes('/repo/src/auth/session.ts'));
    claude.cwd = repo; claude.session_id = 'claude-code'; claude.tool_input.file_path = `${repo}/src/auth/session.ts`;
    codex.cwd = repo; codex.session_id = 'codex'; codex.tool_input.command = codex.tool_input.command.replaceAll('/repo/', `${repo}/`);
    expect(editPaths('codex', HookPayloadSchema.parse(codex), repo).length).toBeGreaterThan(1);
    expect((await hook('claude-code', claude)).json()).toEqual({});
    const start = performance.now();
    const response = (await hook('codex', codex)).json();
    expect(performance.now() - start).toBeLessThan(300);
    expect(response.hookSpecificOutput?.permissionDecision).toBe(enforce === 'hold' ? 'deny' : undefined);
    expect(JSON.stringify(response)).toContain('src/auth/session.ts');
    const state = (await app.inject('/v1/state')).json<TowerState>();
    expect(state.collisions).toHaveLength(1);
    expect(state.recentEvents.filter(e => e.type === 'hold.applied')).toHaveLength(enforce === 'hold' ? 1 : 0);
    await hook('codex', codex);
    const after = (await app.inject('/v1/state')).json<TowerState>();
    expect(after.recentEvents.filter(e => e.type === 'mail.delivered' && e.data.to === 'codex:codex')).toHaveLength(1);
    expect(after.recentEvents.filter(e => e.type === 'hold.applied')).toHaveLength(enforce === 'hold' ? 1 : 0);
    expect((await hook('claude-code', { hook_event_name: 'Stop', stop_hook_active: true })).json()).toEqual({});
    expect((await hook('claude-code', { hook_event_name: 'Stop' })).json().decision).toBe('block');
    expect((await hook('claude-code', { hook_event_name: 'Stop' })).json()).toEqual({});
    expect((await post('/v1/events', { agentId: 'system', type: 'agent.left', data: {} })).statusCode).toBe(400);
  } finally { await app.close(); vi.unstubAllEnvs(); rmSync(logDir, { recursive: true, force: true }); }
}, 30000);

it('predicts in the background, clears empty predictions, ignores short prompts, and disables detection in scripted mode', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  const logDir = mkdtempSync(join(tmpdir(), 'tower-predict-'));
  const { app } = await createServer({ logDir });
  const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/events', payload });
  const state = async () => (await app.inject('/v1/state')).json<TowerState>();
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    for (const id of ['a','b']) await post({ agentId:id,type:'agent.joined',data:{agent:{id,tool:'sim',pilot:id,repoId:'demo',worktree:'/tmp',branch:'',color:'',status:'thinking',joinedAt:0,lastSeen:0}} });
    await post({agentId:'a',type:'file.edit',data:{path:'src/auth/session.ts',op:'modify'}});
    await post({agentId:'b',type:'intent.declared',data:{text:'add session expiry checks',predictedFiles:[]}});
    await settle();
    expect((await state()).collisions).toHaveLength(1);
    expect((await state()).claims.some(c => c.agentId==='b' && c.mode==='planned')).toBe(true);
    await post({agentId:'b',type:'intent.declared',data:{text:'unrelated new task completely',predictedFiles:[]}});
    await settle();
    expect((await state()).claims.some(c => c.agentId==='b')).toBe(false);
    const seq = (await state()).lastSeq;
    await post({agentId:'b',type:'intent.declared',data:{text:'yes continue',predictedFiles:[]}});
    await settle();
    expect((await state()).lastSeq).toBe(seq+1);
    await app.inject({method:'POST',url:'/v1/admin/reset',payload:{mode:'scripted'}});
    expect((await post({agentId:'system',type:'collision.detected',data:{collisionId:'scripted',agentIds:['a','b'],files:['x'],level:'plan',summary:'recorded'}})).statusCode).toBe(200);
    expect((await state()).claims).toEqual([]);
  } finally { await app.close();vi.unstubAllEnvs();rmSync(logDir,{recursive:true,force:true}); }
},30000);

it('sends only bounded prompt and paths to prediction and accepts valid model JSON', async () => {
  const paths = ['src/auth/session.ts'];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages[0].content);
    expect(Object.keys(input).sort()).toEqual(['paths','prompt']);
    expect(input.prompt).toHaveLength(500);
    expect(input.paths).toEqual(paths);
    return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({summary:'Session expiry',files:[...paths,'unknown.ts']})}]}));
  });
  expect(await predictTask('x'.repeat(700), paths, {key:'test',fetch:fetcher as typeof fetch})).toEqual({summary:'Session expiry',files:paths});
});
