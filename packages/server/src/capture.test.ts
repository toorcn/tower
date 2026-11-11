import { afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './index.js';
import { HookRequestSchema, type TowerState } from '../../shared/src/index.js';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tower-capture-route-')));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
it('captures sibling worktrees, deduplicates reads, adds created nodes, and resets live state', async () => {
  const repo = join(dir, 'demo-app'); const sibling = join(dir, 'demo-app-sarah');
  mkdirSync(join(repo, 'src/auth'), { recursive: true });
  writeFileSync(join(repo, 'src/auth/session.ts'), 'export const expiry = 60;\n');
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('add', '.'); git('-c', 'user.name=Tower', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git('worktree', 'add', '-qb', 'sarah', sibling);
  const logDir = join(dir, 'logs');
  const { app } = await createServer({ repo, logDir });
  const hook = async (worktree: string, tool: 'claude-code' | 'codex', payload: object) => {
    const response = await app.inject({ method: 'POST', url: '/v1/hook', payload: {
      tool, pilot: tool === 'codex' ? 'Sarah' : 'Hong', branch: tool, worktree,
      payload: { session_id: tool, cwd: worktree, ...payload },
    } });
    expect(response.statusCode).toBe(200);
  };
  const state = async () => (await app.inject('/v1/state')).json<TowerState>();
  try {
    await hook(repo, 'claude-code', { hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(600), env: { SECRET: 'never-store-this' } });
    await hook(repo, 'claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src/auth/session.ts') } });
    await hook(repo, 'claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src/auth/session.ts') } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2100);
    await hook(repo, 'claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src/auth/session.ts') } });
    clock.mockRestore();
    await hook(sibling, 'codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/auth/session.ts' } });
    for (const [worktree, tool] of [[repo, 'claude-code'], [sibling, 'codex']] as const) {
      await hook(worktree, tool, { hook_event_name: 'PostToolUse', tool_name: tool === 'codex' ? 'apply_patch' : 'Edit', tool_input: tool === 'codex'
        ? { command: '*** Begin Patch\n*** Update File: src/auth/session.ts\n*** End Patch' }
        : { file_path: join(worktree, 'src/auth/session.ts'), new_string: 'never-store-this' }, tool_response: { exit_code: 0 } });
    }
    const current = await state();
    expect(current.mode).toBe('live');
    expect(current.agents.map(a => [a.pilot, a.repoId])).toEqual([['Hong', 'demo-app'], ['Sarah', 'demo-app']]);
    expect(current.recentEvents.filter(e => e.type === 'file.read')).toHaveLength(3);
    expect(current.recentEvents.filter(e => e.type === 'file.edit').map(e => e.data)).toEqual([
      { path: 'src/auth/session.ts', op: 'modify' }, { path: 'src/auth/session.ts', op: 'modify' },
    ]);
    writeFileSync(join(sibling, 'src/auth/new.ts'), 'export const added = true;\n');
    await hook(sibling, 'codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src/auth/new.ts\n*** End Patch' }, tool_response: { exit_code: 0 } });
    expect((await app.inject('/v1/graph')).json().nodes.some((n: { path: string }) => n.path === 'src/auth/new.ts')).toBe(true);
    expect(readdirSync(logDir).map(p => readFileSync(join(logDir, p), 'utf8')).join('')).not.toContain('never-store-this');
    expect((await app.inject({ method: 'POST', url: '/v1/events', payload: { agentId: 'system', type: 'agent.status', data: { status: 'idle' } } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/v1/admin/reset', payload: {} });
    expect((await state()).agents).toEqual([]);
    expect((await state()).mode).toBe('live');
    expect((await app.inject('/v1/graph')).json().nodes.some((n: { path: string }) => n.path === 'src/auth/new.ts')).toBe(false);
  } finally { vi.restoreAllMocks(); await app.close(); }
}, 30_000);

it('validates and strips sensitive hook fields at the shared boundary', () => {
  const value = HookRequestSchema.parse({ tool: 'codex', pilot: 'Sarah', branch: 'sarah', worktree: '/repo', payload: {
    session_id: 'one', cwd: '/repo', hook_event_name: 'PostToolUse', tool_input: { command: '*** Begin Patch\n*** Add File: a.ts\n+private contents\n*** End Patch', env: { SECRET: 'value' } },
    tool_response: { exit_code: 0, stdout: 'private output' }, transcript_path: '/private/transcript',
  } });
  expect(JSON.stringify(value)).not.toMatch(/private|SECRET/);
  expect(value.payload.tool_input?.command).toContain('*** Add File: a.ts');
});
