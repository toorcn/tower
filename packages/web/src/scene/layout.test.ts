import { describe, expect, it } from 'vitest';
import { addNode, clusterKey, layoutGraph, type GraphNode } from './layout';

const node = (path: string, loc = 0): GraphNode => ({ path, dir: path.split('/').slice(0, -1).join('/') || '.', loc, ext: 'ts' });
const graph = [
  ...['session', 'tokens', 'refresh', 'login', 'logout', 'expiry', 'cookies', 'index'].map(n => node(`src/auth/${n}.ts`, 120)),
  ...['theme', 'profile', 'storage', 'index'].map(n => node(`src/settings/${n}.ts`, 40)),
  ...['routes', 'users'].map(n => node(`src/api/${n}.ts`)),
  node('README.md', 30),
  node('packages/web/src/deep/file.ts'),
];
const positions = (l: ReturnType<typeof layoutGraph>) => [...l.stars.values()].map(s => `${s.path}@${s.x},${s.y}`).sort();

describe('constellation layout', () => {
  it('groups by the first two directory segments', () => {
    expect(clusterKey('src/auth/session.ts')).toBe('src/auth');
    expect(clusterKey('packages/web/src/deep/file.ts')).toBe('packages/web');
    expect(clusterKey('README.md')).toBe('.');
  });
  it('is identical on every run and independent of input order', () => {
    const a = layoutGraph(graph);
    const b = layoutGraph([...graph].reverse());
    expect(positions(a)).toEqual(positions(b));
    expect(positions(layoutGraph(graph))).toEqual(positions(a));
  });
  it('puts the largest cluster in the middle and keeps clusters apart', () => {
    const l = layoutGraph(graph);
    expect(l.clusters.get('src/auth')).toMatchObject({ x: 0, y: 0 });
    const cs = [...l.clusters.values()];
    for (const a of cs) for (const b of cs) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
  });
  it('draws a spanning tree per cluster', () => {
    const l = layoutGraph(graph);
    expect(l.edges.get('src/auth')).toHaveLength(7);
    expect(l.edges.get('src/api')).toHaveLength(1);
    expect(l.edges.get('.')).toHaveLength(0);
  });
  it('adds later files without moving existing stars', () => {
    const l = layoutGraph(graph);
    const before = positions(l);
    const star = addNode(l, node('src/auth/invalidate.ts'));
    addNode(l, node('scripts/new/thing.sh'));
    expect(positions(l).filter(p => before.includes(p))).toEqual(before);
    const auth = l.clusters.get('src/auth')!;
    expect(Math.hypot(star.x - auth.x, star.y - auth.y)).toBeLessThan(auth.r);
    for (const s of l.stars.values()) if (s !== star && s.cluster === 'src/auth') expect(Math.hypot(s.x - star.x, s.y - star.y)).toBeGreaterThan(s.r + star.r);
    expect(l.clusters.has('scripts/new')).toBe(true);
  });
});
