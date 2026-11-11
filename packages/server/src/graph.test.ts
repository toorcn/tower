import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { graphNode, resolveRepoId, scanGraph } from './graph.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repository() {
  const target = mkdtempSync(join(tmpdir(), 'tower-graph-')); temporary.push(target);
  const root = join(target, 'demo-app'); mkdirSync(root);
  git(root, 'init', '-q');
  return { target, root };
}

it('scans tracked source with line counts and skips lockfiles, images, binaries and long files', () => {
  const { root } = repository(); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'first\nsecond\n');
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, 'single.txt'), 'single');
  writeFileSync(join(root, 'limit.ts'), 'line\n'.repeat(2000));
  writeFileSync(join(root, 'long.ts'), 'line\n'.repeat(2001));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfile');
  writeFileSync(join(root, 'image.png'), 'image');
  writeFileSync(join(root, 'binary.dat'), Buffer.from([65, 0, 66]));
  writeFileSync(join(root, 'invalid.dat'), Buffer.from([255, 254, 253]));
  git(root, 'add', '.');
  writeFileSync(join(root, 'untracked.ts'), 'untracked');
  const graph = scanGraph(root);
  expect(graph.repoId).toBe('demo-app');
  expect(graph.nodes.map(node => node.path)).toEqual(['empty.txt', 'limit.ts', 'single.txt', 'src/app.ts']);
  expect(graph.nodes.find(node => node.path === 'src/app.ts')).toEqual({ path: 'src/app.ts', dir: 'src', loc: 2, ext: 'ts' });
  expect(graph.nodes.find(node => node.path === 'empty.txt')?.loc).toBe(0);
  expect(graph.nodes.find(node => node.path === 'single.txt')?.loc).toBe(1);
});

it('uses the same repository identity for linked worktrees', () => {
  const { root, target } = repository(); writeFileSync(join(root, 'app.ts'), 'export {};\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Tower', '-c', 'user.email=tower@localhost', 'commit', '-qm', 'base');
  const sibling = join(target, 'demo-app-sarah'); git(root, 'worktree', 'add', '-qb', 'demo/sarah', sibling);
  expect(resolveRepoId(sibling)).toBe('demo-app');
  expect(scanGraph(sibling)).toEqual(scanGraph(root));
});

it('rejects outside paths, symlinks and missing nodes, while accepting a newly created file', () => {
  const { root, target } = repository();
  writeFileSync(join(target, 'outside.ts'), 'outside');
  symlinkSync(join(target, 'outside.ts'), join(root, 'external.ts'));
  symlinkSync(target, join(root, 'external-dir'));
  writeFileSync(join(root, 'new.ts'), 'export {};\n');
  expect(graphNode(root, 'new.ts')).toEqual({ path: 'new.ts', dir: '.', loc: 1, ext: 'ts' });
  for (const path of ['../outside.ts', join(target, 'outside.ts'), 'external.ts', 'external-dir/outside.ts', 'missing.ts', 'C:/outside.ts', 'src\\app.ts']) expect(graphNode(root, path)).toBeUndefined();
});

it('rescans tracked paths after changes instead of retaining stale nodes', () => {
  const { root } = repository(); writeFileSync(join(root, 'first.ts'), 'first'); git(root, 'add', '.');
  expect(scanGraph(root).nodes.map(node => node.path)).toEqual(['first.ts']);
  writeFileSync(join(root, 'second.ts'), 'second'); git(root, 'add', '.');
  expect(scanGraph(root).nodes.map(node => node.path)).toEqual(['first.ts', 'second.ts']);
});
