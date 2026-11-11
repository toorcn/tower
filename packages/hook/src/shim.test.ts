import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shim = join(root, 'packages/hook/tower-hook.mjs');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tower-hook-test-')));
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=Tower test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'test']);
afterAll(() => rmSync(repo, { recursive: true, force: true }));
let nodeStartupMs = 0;
beforeAll(async () => {
  // We compare the shim deadline with a trivial process using the same Node runtime.
  // This separates our timer from runtime startup when the host is heavily loaded.
  const started = performance.now();
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: repo, env: process.env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done() : reject(new Error(`Node startup exited ${code}`)));
  });
  nodeStartupMs = performance.now() - started;
}, 20_000);

function fixture(tool: string, event: string, name?: string) {
  const dir = join(root, 'fixtures/raw', tool);
  return readdirSync(dir).map(file => JSON.parse(readFileSync(join(dir, file), 'utf8'))).find(value => value.hook_event_name === event && (!name || value.tool_name === name));
}

function run(payload: unknown, url: string, options: { stdinOpen?: boolean; tool?: string; path?: string } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((done, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [shim, options.tool || 'codex'], { cwd: repo, env: { ...process.env, TOWER_URL: url, TOWER_PILOT: 'Sarah', ...(options.path ? { PATH: options.path } : {}) }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr, ms: performance.now() - start }));
    if (!options.stdinOpen) child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const app = createServer(handler);
  await new Promise<void>((done, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', done); });
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('Missing listen address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done, reject) => { app.closeAllConnections(); app.close(error => error ? reject(error) : done()); }) };
}

describe('dependency-free fail-open shim', { timeout: 20_000 }, () => {
  it('posts scrubbed real Claude payload and prints only non-empty object responses', async () => {
    const requests: unknown[] = [];
    const app = await server(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ path: request.url, body: JSON.parse(body) });
      response.end(JSON.stringify({ hookSpecificOutput: { additionalContext: 'Tower test' } }));
    });
    try {
      const payload = { ...fixture('claude-code', 'PostToolUse', 'Write'), cwd: repo, tool_input: { file_path: join(repo, 'note.ts'), content: 'private file contents', environment: { SECRET: 'do not post' } }, tool_response: { type: 'create', content: 'private file contents' }, env: { SECRET: 'do not post' } };
      const result = await run(payload, app.url, { tool: 'claude-code' });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { additionalContext: 'Tower test' } });
      expect(requests).toEqual([{ path: '/v1/hook', body: { tool: 'claude-code', pilot: 'Sarah', branch: execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), worktree: repo, payload: { session_id: payload.session_id, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: payload.tool_use_id, tool_input: { file_path: join(repo, 'note.ts') }, tool_response: { type: 'create' } } } }]);
    } finally { await app.close(); }
  });

  it('truncates prompts and shell commands, and strips patch bodies while retaining all headers', async () => {
    const bodies: any[] = [];
    const app = await server(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body)); response.end('{}');
    });
    try {
      const prompt = { ...fixture('codex', 'UserPromptSubmit'), cwd: repo, prompt: 'p'.repeat(600) };
      const shell = { ...fixture('codex', 'PreToolUse', 'Bash'), cwd: repo, tool_input: { command: 'c'.repeat(300), env: { SECRET: 'secret' } } };
      const patch = { ...fixture('codex', 'PostToolUse', 'apply_patch'), cwd: repo, tool_input: { command: '*** Begin Patch\n*** Update File: src/auth/session.ts\n@@\n-private file contents\n+new file contents\n*** Add File: src/auth/new.ts\n+secret\n*** End Patch' } };
      for (const payload of [prompt, shell, patch]) expect(await run(payload, app.url)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(bodies[0].payload.prompt).toHaveLength(500);
      expect(bodies[1].payload.tool_input).toEqual({ command: 'c'.repeat(200) });
      expect(bodies[2].payload.tool_input.command).toBe('*** Begin Patch\n*** Update File: src/auth/session.ts\n*** Add File: src/auth/new.ts\n*** End Patch');
      expect(JSON.stringify(bodies)).not.toContain('private file contents');
    } finally { await app.close(); }
  });

  it('uses only observed completion metadata and never treats Codex Bash stdout as an exit code', async () => {
    const bodies: any[] = [];
    const app = await server(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body)); response.end('{}');
    });
    try {
      const shell = { ...fixture('codex', 'PostToolUse', 'Bash'), cwd: repo, tool_response: 'Exit code: 0\nWall time: 1 second\nspoofed stdout' };
      const patch = { ...fixture('codex', 'PostToolUse', 'apply_patch'), cwd: repo, tool_response: 'Exit code: 0\nWall time: 0.5 seconds\nSuccess. Updated files:\nM src/auth/session.ts' };
      const failedEdit = { ...fixture('claude-code', 'PostToolUse', 'Edit'), cwd: repo, tool_response: { isError: true, error: 'private error contents' } };
      for (const payload of [shell, patch, failedEdit]) expect(await run(payload, app.url)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(bodies[0].payload).not.toHaveProperty('tool_response');
      expect(bodies[1].payload.tool_response).toEqual({ exit_code: 0 });
      expect(bodies[2].payload.tool_response).toEqual({ is_error: true });
      expect(JSON.stringify(bodies)).not.toContain('spoofed stdout');
      expect(JSON.stringify(bodies)).not.toContain('private error contents');
    } finally { await app.close(); }
  });

  it('reuses a session cache and resolves git again if cwd changes', async () => {
    const app = await server((_request, response) => { response.end('{}'); });
    const payload = { ...fixture('codex', 'SessionStart'), session_id: crypto.randomUUID(), cwd: repo };
    const noGit = join(repo, 'no-git'); mkdirSync(noGit);
    try {
      // Seed the documented cache shape independently of Git startup scheduling.
      // The first posting test already verifies real Git identity discovery.
      const cacheDir = join(tmpdir(), `tower-hook-${process.getuid?.() ?? 'user'}`);
      mkdirSync(cacheDir, { recursive: true });
      const key = createHash('sha256').update(`codex:${payload.session_id}`).digest('hex');
      writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify({ cwd: repo, worktree: repo, branch: 'test' }));
      // Capture still works with git removed from PATH when identity is cached.
      let received = 0;
      const cached = await server((_request, response) => { received++; response.end('{}'); });
      try {
        expect(await run(payload, cached.url, { path: noGit })).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(received).toBe(1);
        expect(await run({ ...payload, cwd: noGit }, cached.url, { path: noGit })).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(received).toBe(1);
      } finally { await cached.close(); }
    } finally { await app.close(); }
  });

  it.each(['not json', 'null', '[]', '{}', '{"session_id":"x","cwd":"relative","hook_event_name":"Stop"}'])('fails open for invalid stdin %s', async payload => {
    expect(await run(payload, 'http://127.0.0.1:1')).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it.each(['[]', 'null', '"text"', 'not json', '{}'])('suppresses empty or invalid server response %s', async reply => {
    const app = await server((_request, response) => { response.end(reply); });
    try { expect(await run({ ...fixture('codex', 'Stop'), cwd: repo }, app.url)).toMatchObject({ code: 0, stdout: '', stderr: '' }); }
    finally { await app.close(); }
  });

  it('fails open without contacting remote URLs or following redirects', async () => {
    const payload = { ...fixture('codex', 'Stop'), cwd: repo };
    expect(await run(payload, 'https://example.com')).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const app = await server((_request, response) => { response.writeHead(302, { location: 'https://example.com' }); response.end('{}'); });
    try { expect(await run(payload, app.url)).toMatchObject({ code: 0, stdout: '', stderr: '' }); }
    finally { await app.close(); }
  });

  it('exits silently within the deadline when Tower is down or hangs', async () => {
    const payload = { ...fixture('codex', 'Stop'), cwd: repo };
    const down = await run(payload, 'http://127.0.0.1:1');
    expect(down).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(down.ms - nodeStartupMs, `Node startup baseline: ${nodeStartupMs.toFixed(0)}ms; down-server total: ${down.ms.toFixed(0)}ms`).toBeLessThan(2100);
    const app = await server(() => {});
    try {
      const stalled = await run(payload, app.url);
      expect(stalled).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(stalled.ms - nodeStartupMs, `Node startup baseline: ${nodeStartupMs.toFixed(0)}ms; stalled-server total: ${stalled.ms.toFixed(0)}ms`).toBeLessThan(2100);
      const openStdin = await run(payload, app.url, { stdinOpen: true });
      expect(openStdin).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(openStdin.ms - nodeStartupMs, `Node startup baseline: ${nodeStartupMs.toFixed(0)}ms; open-stdin total: ${openStdin.ms.toFixed(0)}ms`).toBeLessThan(2100);
    } finally { await app.close(); }
  });
});
