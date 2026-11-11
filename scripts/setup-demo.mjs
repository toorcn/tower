#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const towerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['hong', 'sarah', 'wei'];
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, path, contents) => {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
};
const canonicalDestination = path => {
  const tail = [];
  while (!existsSync(path)) { tail.unshift(basename(path)); path = dirname(path); }
  return resolve(realpathSync(path), ...tail);
};

function sourceFiles() {
  const paths = {
    auth: ['cookies', 'expiry', 'index', 'login', 'logout', 'middleware', 'permissions', 'refresh', 'session', 'tokens'],
    settings: ['appearance', 'index', 'notifications', 'preferences', 'profile', 'shortcuts', 'storage', 'theme'],
    api: ['client', 'errors', 'headers', 'index', 'retry', 'routes', 'sessions', 'users'],
    ui: ['button', 'colors', 'dialog', 'form', 'icons', 'index', 'input', 'layout', 'menu', 'panel', 'spinner', 'toast', 'toggle', 'typography'],
  };
  const files = {};
  for (const [directory, modules] of Object.entries(paths)) for (const name of modules) {
    files[`src/${directory}/${name}.ts`] = `export const ${directory}${name[0].toUpperCase() + name.slice(1)} = '${name}';\n`;
  }
  Object.assign(files, {
    'src/auth/tokens.ts': `export interface RefreshToken { value: string; sessionId: string; expiresAt: number; revoked: boolean; }

export function createRefreshToken(sessionId: string, value: string, now: number, ttlMs = 86_400_000): RefreshToken {
  return { value, sessionId, expiresAt: now + ttlMs, revoked: false };
}

export function isRefreshTokenValid(token: RefreshToken, now: number): boolean {
  return !token.revoked && token.expiresAt > now;
}

export function revokeRefreshToken(token: RefreshToken): RefreshToken {
  return { ...token, revoked: true };
}
`,
    'src/auth/session.ts': `export interface Session { id: string; userId: string; createdAt: number; expiresAt: number; revoked: boolean; }

export const SESSION_TTL_MS = 3_600_000;

export function createSession(id: string, userId: string, now: number): Session {
  return { id, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS, revoked: false };
}

export function isSessionActive(session: Session, now: number): boolean {
  return !session.revoked && session.expiresAt > now;
}

export function revokeSession(session: Session): Session {
  return { ...session, revoked: true };
}
`,
    'src/auth/login.ts': `import { createSession } from './session.js';
import { createRefreshToken } from './tokens.js';

export function login(userId: string, sessionId: string, tokenValue: string, now: number) {
  return { session: createSession(sessionId, userId, now), token: createRefreshToken(sessionId, tokenValue, now) };
}
`,
    'src/auth/logout.ts': `import { revokeSession, type Session } from './session.js';
import { revokeRefreshToken, type RefreshToken } from './tokens.js';

export function logout(session: Session, token: RefreshToken) {
  return { session: revokeSession(session), token: revokeRefreshToken(token) };
}
`,
    'src/auth/refresh.ts': `import { isSessionActive, type Session } from './session.js';
import { isRefreshTokenValid, type RefreshToken } from './tokens.js';

export function canRefresh(session: Session, token: RefreshToken, now: number): boolean {
  return token.sessionId === session.id && isSessionActive(session, now) && isRefreshTokenValid(token, now);
}
`,
    'src/auth/expiry.ts': `import type { Session } from './session.js';
export function sessionTimeRemaining(session: Session, now: number): number {
  return session.revoked ? 0 : Math.max(0, session.expiresAt - now);
}
`,
    'src/auth/middleware.ts': `import { isSessionActive, type Session } from './session.js';
export function requireSession(session: Session | undefined, now: number): string {
  if (!session || !isSessionActive(session, now)) throw new Error('Session expired');
  return session.userId;
}
`,
    'src/auth/permissions.ts': `export function canEditSettings(viewerId: string, ownerId: string): boolean {
  return viewerId === ownerId;
}
`,
    'src/auth/cookies.ts': `export function sessionCookie(sessionId: string): string {
  return 'session=' + encodeURIComponent(sessionId) + '; HttpOnly; SameSite=Lax; Path=/';
}
`,
    'src/auth/index.ts': `export * from './session.js';
export * from './tokens.js';
export * from './login.js';
export * from './logout.js';
export * from './refresh.js';
`,
    'src/settings/preferences.ts': `export interface Preferences { theme: 'light' | 'dark'; notifications: boolean; }
export const defaultPreferences: Preferences = { theme: 'light', notifications: true };
`,
    'src/settings/theme.ts': `import type { Preferences } from './preferences.js';
export function themeColors(theme: Preferences['theme']) {
  return theme === 'dark' ? { background: '#16181d', foreground: '#f5f5f5' } : { background: '#ffffff', foreground: '#16181d' };
}
`,
    'src/settings/appearance.ts': `import { themeColors } from './theme.js';
import type { Preferences } from './preferences.js';
export function appearance(preferences: Preferences) { return themeColors(preferences.theme); }
`,
    'src/settings/notifications.ts': `export function notificationLabel(enabled: boolean): string { return enabled ? 'Notifications on' : 'Notifications off'; }
`,
    'src/settings/profile.ts': `export interface Profile { id: string; displayName: string; }
export function profileLabel(profile: Profile): string { return profile.displayName.trim() || profile.id; }
`,
    'src/settings/storage.ts': `import { defaultPreferences, type Preferences } from './preferences.js';
export function loadPreferences(value: Partial<Preferences>): Preferences { return { ...defaultPreferences, ...value }; }
`,
    'src/settings/shortcuts.ts': `export const shortcuts = { settings: 's', logout: 'q' } as const;
`,
    'src/settings/index.ts': `export * from './preferences.js';
export * from './theme.js';
export * from './appearance.js';
`,
    'src/api/client.ts': `export interface ApiResponse<T> { status: number; data: T; }
export function ok<T>(data: T): ApiResponse<T> { return { status: 200, data }; }
`,
    'src/api/sessions.ts': `import { isSessionActive, type Session } from '../auth/session.js';
export function activeSessions(sessions: Session[], now: number): Session[] { return sessions.filter(session => isSessionActive(session, now)); }
`,
    'src/api/users.ts': `export interface User { id: string; name: string; }
export function findUser(users: User[], id: string): User | undefined { return users.find(user => user.id === id); }
`,
    'src/api/headers.ts': `export const jsonHeaders = { 'content-type': 'application/json' } as const;
`,
    'src/api/errors.ts': `export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Request failed'; }
`,
    'src/api/retry.ts': `export function retryDelay(attempt: number): number { return Math.min(1000, 100 * 2 ** Math.max(0, attempt)); }
`,
    'src/api/routes.ts': `export const routes = { sessions: '/sessions', users: '/users', settings: '/settings' } as const;
`,
    'src/api/index.ts': `export * from './client.js';
export * from './routes.js';
export * from './sessions.js';
`,
  });
  for (const name of paths.ui.filter(name => name !== 'index')) {
    files[`src/ui/${name}.ts`] = `export function ${name}Label(value: string): string { return value.trim(); }\n`;
  }
  files['src/ui/index.ts'] = `export * from './button.js';\nexport * from './panel.js';\nexport * from './toggle.js';\n`;
  return files;
}

function setup(targetArgument) {
  const target = canonicalDestination(resolve(targetArgument));
  const fromTower = relative(realpathSync(towerRoot), target);
  if (!fromTower || (!fromTower.startsWith('..' + '/') && fromTower !== '..' && !isAbsolute(fromTower))) throw new Error('We create the demo outside the Tower workspace. Choose another target directory.');
  const repo = join(target, 'demo-app');
  const bin = join(target, '.tower-bin');
  const manifestPath = join(target, '.tower-demo.json');
  for (const path of [repo, bin, manifestPath, ...names.map(name => join(target, `demo-app-${name}`))]) {
    if (existsSync(path)) throw new Error(`We will not overwrite ${path}. Use a new target directory.`);
  }
  const compiler = join(towerRoot, 'node_modules/typescript/bin/tsc');
  if (!existsSync(compiler)) throw new Error('We need Tower dependencies first. Run pnpm install in the Tower workspace.');
  mkdirSync(target, { recursive: true });
  mkdirSync(bin);
  symlinkSync(join(towerRoot, 'packages/hook/tower-hook.mjs'), join(bin, 'tower-hook'));
  mkdirSync(repo);
  for (const [path, contents] of Object.entries(sourceFiles())) write(repo, path, contents);
  write(repo, '.gitignore', 'node_modules/\n.test-build/\n');
  write(repo, 'package.json', JSON.stringify({ name: 'tower-demo-app', private: true, type: 'module', engines: { node: '>=20' }, scripts: { build: 'node scripts/test.mjs --build-only', test: 'node scripts/test.mjs', typecheck: 'node scripts/test.mjs --typecheck' } }, null, 2) + '\n');
  write(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: '.test-build', rootDir: 'src', skipLibCheck: true }, include: ['src/**/*.ts'] }, null, 2) + '\n');
  write(repo, 'scripts/test.mjs', `import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [${JSON.stringify(compiler)}, '-p', root, ...(process.argv.includes('--typecheck') ? ['--noEmit'] : [])], { cwd: root, stdio: 'inherit' });
if (!process.argv.includes('--typecheck') && !process.argv.includes('--build-only')) execFileSync(process.execPath, ['--test', 'tests/auth.test.mjs', 'tests/settings.test.mjs'], { cwd: root, stdio: 'inherit' });
`);
  write(repo, 'tests/auth.test.mjs', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, isSessionActive, revokeSession, SESSION_TTL_MS } from '../.test-build/auth/session.js';
import { createRefreshToken, isRefreshTokenValid, revokeRefreshToken } from '../.test-build/auth/tokens.js';
import { canRefresh } from '../.test-build/auth/refresh.js';
import { logout } from '../.test-build/auth/logout.js';

test('sessions expire at their deadline and revocation keeps other sessions active', () => {
  const first = createSession('one', 'user', 1000);
  const second = createSession('two', 'user', 1000);
  assert.equal(isSessionActive(first, 1000 + SESSION_TTL_MS - 1), true);
  assert.equal(isSessionActive(first, 1000 + SESSION_TTL_MS), false);
  assert.equal(isSessionActive(revokeSession(first), 1001), false);
  assert.equal(isSessionActive(second, 1001), true);
});
test('refresh requires a valid token for the same active session', () => {
  const session = createSession('one', 'user', 1000);
  const token = createRefreshToken('one', 'value', 1000);
  assert.equal(canRefresh(session, token, 1001), true);
  assert.equal(canRefresh(session, { ...token, sessionId: 'two' }, 1001), false);
  assert.equal(canRefresh(revokeSession(session), token, 1001), false);
  assert.equal(isRefreshTokenValid(token, token.expiresAt), false);
  assert.equal(isRefreshTokenValid(revokeRefreshToken(token), 1001), false);
});
test('logout revokes both the session and refresh token', () => {
  const result = logout(createSession('one', 'user', 1000), createRefreshToken('one', 'value', 1000));
  assert.equal(isSessionActive(result.session, 1001), false);
  assert.equal(isRefreshTokenValid(result.token, 1001), false);
});
`);
  write(repo, 'tests/settings.test.mjs', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearance } from '../.test-build/settings/appearance.js';
import { loadPreferences } from '../.test-build/settings/storage.js';
test('appearance follows saved theme preferences', () => {
  assert.equal(loadPreferences({}).theme, 'light');
  assert.equal(appearance(loadPreferences({ theme: 'dark' })).background, '#16181d');
});
`);
  for (const [directory, tool, filename] of [['.claude', 'claude-code', 'settings.json'], ['.codex', 'codex', 'hooks.json']]) {
    const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: `${quote(join(bin, 'tower-hook'))} ${tool}`, timeout: event === 'SessionEnd' && tool === 'codex' ? 3 : 5 }] }]]));
    write(repo, `${directory}/${filename}`, JSON.stringify({ hooks }, null, 2) + '\n');
  }
  write(repo, '.codex/config.toml', '[features]\nhooks = true\n');
  write(repo, 'AGENTS.md', `# Demo app\n\nWe keep sessions in src/auth/session.ts and refresh tokens in src/auth/tokens.ts. We run pnpm test after changes. We keep edits small and use the file tools when available.\n`);
  write(repo, 'CLAUDE.md', `# Demo app\n\nWe keep sessions in src/auth/session.ts and refresh tokens in src/auth/tokens.ts. We run pnpm test after changes. We use Read, Grep, Edit and Write for file operations.\n`);
  write(repo, 'README.md', `# Tower demo app\n\nWe use this small TypeScript app to rehearse capture from real coding sessions. We keep session and token rules in src/auth/session.ts and src/auth/tokens.ts. We use Tower's installed TypeScript compiler so installation and tests need no network.\n\nWe run pnpm install --offline, then pnpm test. We can also run pnpm typecheck. We keep generated JavaScript in .test-build.\n`);
  git(repo, 'init', '-q', '-b', 'demo/base');
  const start = performance.now();
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: repo, stdio: 'pipe' });
  execFileSync('pnpm', ['test'], { cwd: repo, stdio: 'inherit' });
  const testMs = Math.round(performance.now() - start);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Tower demo', '-c', 'user.email=tower-demo@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Demo base with capture hooks');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'tower-demo-base', base);
  const worktrees = names.map(name => ({ path: join(target, `demo-app-${name}`), branch: `demo/${name}` }));
  for (const { path, branch } of worktrees) git(repo, 'worktree', 'add', '-q', '-b', branch, path, base);
  const manifest = { format: 'tower-demo-v1', root: realpathSync(target), repo: realpathSync(repo), base, worktrees: worktrees.map(tree => ({ ...tree, path: realpathSync(tree.path) })) };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWe created 40 source files and three worktrees. Install and tests took ${testMs} ms.`);
  console.log(`We start Tower with TOWER_REPO=${quote(repo)} pnpm dev from the Tower workspace.`);
  console.log('We start the three sessions with:');
  for (const [index, pilot] of ['Hong', 'Sarah', 'Wei'].entries()) console.log(`cd ${quote(worktrees[index].path)} && PATH=${quote(bin)}:"$PATH" TOWER_PILOT=${pilot} ${pilot === 'Sarah' ? 'codex' : 'claude'}`);
  console.log('We review and trust the Codex project and hooks once with /hooks before using the Sarah session.');
  console.log(`We reset all generated checkouts and Tower with ${quote(join(towerRoot, 'scripts/reset-demo.sh'))} ${quote(target)}.`);
}

async function reset(targetArgument) {
  const target = realpathSync(resolve(targetArgument));
  const manifest = JSON.parse(readFileSync(join(target, '.tower-demo.json'), 'utf8'));
  const repo = join(target, 'demo-app');
  if (manifest.format !== 'tower-demo-v1' || manifest.root !== target || manifest.repo !== repo || !/^[a-f0-9]{40}$/.test(manifest.base)) throw new Error('We could not validate the generated demo manifest.');
  if (realpathSync(repo) !== repo || git(repo, 'rev-parse', 'tower-demo-base') !== manifest.base) throw new Error('The demo base no longer matches the generated manifest.');
  const trees = [{ path: repo, branch: 'demo/base' }, ...names.map(name => ({ path: join(target, `demo-app-${name}`), branch: `demo/${name}` }))];
  if (JSON.stringify(manifest.worktrees) !== JSON.stringify(trees.slice(1))) throw new Error('The worktree list no longer matches the generated manifest.');
  const commonDir = realpathSync(join(repo, '.git'));
  // We validate every checkout before resetting any checkout.
  for (const tree of trees) {
    if (realpathSync(tree.path) !== tree.path || realpathSync(git(tree.path, 'rev-parse', '--show-toplevel')) !== tree.path
      || realpathSync(resolve(tree.path, git(tree.path, 'rev-parse', '--git-common-dir'))) !== commonDir
      || git(tree.path, 'branch', '--show-current') !== tree.branch) throw new Error(`We will not reset an unexpected checkout: ${tree.path}`);
  }
  for (const tree of trees) {
    git(tree.path, 'reset', '--hard', manifest.base);
    git(tree.path, 'clean', '-fd');
  }
  console.log('We reset the main demo checkout and all three worktrees to the base commit.');
  const url = new URL(process.env.TOWER_URL || 'http://127.0.0.1:4317');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('We only reset a local Tower server.');
  try {
    const response = await fetch(new URL('/v1/admin/reset', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'live' }), signal: AbortSignal.timeout(1500), redirect: 'error' });
    const state = await response.json();
    if (!response.ok || !Array.isArray(state.agents) || state.agents.length !== 0) throw new Error('Tower did not confirm an empty roster.');
    console.log('We cleared Tower state. The roster is empty.');
  } catch (error) {
    throw new Error(`Worktrees are clean, but we could not clear Tower state. We need the local server running. ${error.message}`);
  }
}

const [action, target, ...extra] = process.argv.slice(2);
if (!['setup', 'reset'].includes(action) || !target || extra.length) {
  console.error('Usage: scripts/setup-demo.sh <target-dir> or scripts/reset-demo.sh <target-dir>');
  process.exitCode = 1;
} else {
  try { if (action === 'setup') setup(target); else await reset(target); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
