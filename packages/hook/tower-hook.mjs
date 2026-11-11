#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { userInfo, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubPayload } from './capture-payload.mjs';

// This deadline covers stdin, git and HTTP. Every failure leaves the agent alone.
const deadline = setTimeout(() => process.exit(0), 1500);
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const git = promisify(execFile);

async function identity(tool, payload) {
  if (!isAbsolute(payload.cwd)) throw new Error('Expected absolute cwd');
  const cacheDir = join(tmpdir(), `tower-hook-${process.getuid?.() ?? 'user'}`);
  const key = createHash('sha256').update(`${tool}:${payload.session_id}`).digest('hex');
  const cache = join(cacheDir, `${key}.json`);
  try {
    const saved = JSON.parse(await readFile(cache, 'utf8'));
    if (saved.cwd === payload.cwd && typeof saved.worktree === 'string' && isAbsolute(saved.worktree) && typeof saved.branch === 'string') return saved;
  } catch { /* The first hook resolves git metadata. */ }
  const { stdout } = await git('git', ['-C', payload.cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeout: 400, maxBuffer: 16384, windowsHide: true });
  const [worktree, branch] = stdout.trim().split('\n');
  if (!worktree || !isAbsolute(worktree) || !branch) throw new Error('Missing git identity');
  const result = { cwd: payload.cwd, worktree, branch };
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(cache, JSON.stringify(result), { mode: 0o600 });
  } catch { /* A read-only temp directory must not disable capture. */ }
  return result;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 65536) { response.destroy(); reject(new Error('Response too large')); }
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Bad response'));
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

try {
  const tool = process.argv[2];
  if (!['claude-code', 'codex'].includes(tool)) throw new Error('Unknown tool');
  const base = new URL(process.env.TOWER_URL || 'http://127.0.0.1:4317');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) throw new Error('Expected local URL');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/v1/hook`;
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) throw new Error('Input too large');
  }
  const payload = scrubPayload(JSON.parse(raw));
  if (!payload) throw new Error('Invalid payload');
  const { worktree, branch } = await identity(tool, payload);
  const response = await post(base, JSON.stringify({ tool, pilot: process.env.TOWER_PILOT || userInfo().username, branch, worktree, payload }));
  if (response && typeof response === 'object' && !Array.isArray(response) && Object.keys(response).length) await new Promise(resolve => process.stdout.write(JSON.stringify(response), resolve));
} catch { /* Silence is the fail-open response. */ }
clearTimeout(deadline);
process.exit(0);
