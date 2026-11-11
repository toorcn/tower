import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface GraphNode { path: string; dir: string; loc: number; ext: string }
export interface FileGraph { repoId: string; nodes: GraphNode[] }

const skippedExtensions = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'icns', 'svg', 'bmp', 'tif', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar', 'rar', 'jar', 'wasm', 'exe', 'dll',
  'so', 'dylib', 'o', 'a', 'class', 'pyc', 'pyo', 'mp3', 'mp4', 'mov', 'wav', 'ogg', 'woff',
  'woff2', 'ttf', 'otf', 'eot', 'sqlite', 'db', 'bin', 'psd', 'sketch', 'lock',
]);
const lockfiles = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock',
  'bun.lockb', 'deno.lock', 'Cargo.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock',
  'uv.lock', 'composer.lock', 'packages.lock.json',
]);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
}

export function commonGitDirectory(worktree: string): string {
  const marker = resolve(worktree, '.git');
  let directory = marker;
  if (!lstatSync(marker).isDirectory()) {
    const link = /^gitdir: (.+)\s*$/.exec(readFileSync(marker, 'utf8'));
    if (!link) throw new Error('Invalid git worktree marker');
    directory = resolve(worktree, link[1]);
  }
  const common = resolve(directory, 'commondir');
  return realpathSync(existsSync(common) ? resolve(directory, readFileSync(common, 'utf8').trim()) : directory);
}

// The common git directory is shared by all linked worktrees.
export function resolveRepoId(worktree: string): string {
  const common = commonGitDirectory(worktree);
  if (basename(common) === '.git') return basename(dirname(common));
  const main = git(worktree, ['worktree', 'list', '--porcelain']).split('\n').find(line => line.startsWith('worktree '));
  if (main) return basename(main.slice('worktree '.length));
  return basename(common).replace(/\.git$/, '');
}

export function graphNode(repoRoot: string, path: string): GraphNode | undefined {
  if (!path || isAbsolute(path) || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) return;
  const ext = extname(path).slice(1).toLowerCase();
  if (lockfiles.has(basename(path)) || skippedExtensions.has(ext)) return;
  try {
    const root = realpathSync(repoRoot);
    const file = resolve(root, path);
    const rel = relative(root, file);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    // Symlinks do not represent source files owned by this checkout.
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
    const actual = realpathSync(file);
    const actualRelative = relative(root, actual);
    if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) return;
    const bytes = readFileSync(actual);
    if (bytes.includes(0)) return;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return; }
    const loc = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (loc > 2000) return;
    const posixPath = rel.split(sep).join('/');
    return { path: posixPath, dir: dirname(posixPath), loc, ext };
  } catch { return; }
}

export function scanGraph(repoRoot: string): FileGraph {
  const paths = git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
  const nodes = paths.map(path => graphNode(repoRoot, path)).filter((node): node is GraphNode => node !== undefined);
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return { repoId: resolveRepoId(repoRoot), nodes };
}
