import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { hash, seeded } from './rng';

export interface GraphNode { path: string; dir: string; loc: number; ext: string }
export interface StarLayout { path: string; cluster: string; x: number; y: number; r: number }
export interface ClusterLayout { key: string; x: number; y: number; r: number }
export interface Layout {
  clusters: Map<string, ClusterLayout>;
  stars: Map<string, StarLayout>;
  /** Constellation lines per cluster: a minimum spanning tree over its stars. */
  edges: Map<string, [string, string][]>;
}

/** A cluster is a folder, keyed by the first two path segments of the file's directory. */
export function clusterKey(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.length ? parts.slice(0, 2).join('/') : '.';
}

export function starRadius(loc: number): number {
  return loc > 0 ? 2.6 + Math.min(5.6, Math.sqrt(loc) / 4) : 3.6;
}

const PAD = 11;
const GAP = 40;
const ASPECT = 1.7;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const MARGIN = 20;
const estimate = (n: number) => 30 + Math.sqrt(n) * 17;

function placeCluster(existing: ClusterLayout[], r: number, key: string) {
  if (!existing.length) return { x: 0, y: 0 };
  const angle = existing.length * GOLDEN + (seeded(hash(key))() - 0.5) * 0.6;
  for (let d = 0; ; d += 4) {
    const x = Math.cos(angle) * d * ASPECT;
    const y = Math.sin(angle) * d;
    if (existing.every(c => Math.hypot(c.x - x, c.y - y) > c.r + r + GAP)) return { x, y };
  }
}

function spanningTree(stars: StarLayout[]): [string, string][] {
  if (stars.length < 2) return [];
  const inTree = new Set([0]);
  const best = stars.map(s => Math.hypot(s.x - stars[0].x, s.y - stars[0].y));
  const from = stars.map(() => 0);
  const edges: [string, string][] = [];
  while (inTree.size < stars.length) {
    let pick = -1;
    for (let i = 0; i < stars.length; i++) if (!inTree.has(i) && (pick < 0 || best[i] < best[pick])) pick = i;
    inTree.add(pick);
    edges.push([stars[from[pick]].path, stars[pick].path]);
    for (let i = 0; i < stars.length; i++) {
      if (inTree.has(i)) continue;
      const d = Math.hypot(stars[i].x - stars[pick].x, stars[i].y - stars[pick].y);
      if (d < best[i]) { best[i] = d; from[i] = pick; }
    }
  }
  return edges;
}

/** Pure and seeded: the same set of nodes always gives the same positions, whatever their order. */
export function layoutGraph(nodes: GraphNode[]): Layout {
  const layout: Layout = { clusters: new Map(), stars: new Map(), edges: new Map() };
  const groups = new Map<string, GraphNode[]>();
  for (const node of [...nodes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (layout.stars.has(node.path)) continue;
    const key = clusterKey(node.path);
    groups.set(key, [...(groups.get(key) ?? []), node]);
    layout.stars.set(node.path, { path: node.path, cluster: key, x: 0, y: 0, r: starRadius(node.loc) });
  }
  // Largest cluster first so it lands in the middle.
  const order = [...groups].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [key, list] of order) {
    const rough = estimate(list.length);
    const centre = placeCluster([...layout.clusters.values()], rough, key);
    const random = seeded(hash(key));
    type N = SimulationNodeDatum & { star: StarLayout };
    const simNodes: N[] = list.map(n => ({ star: layout.stars.get(n.path)!, x: centre.x + (random() - 0.5) * rough, y: centre.y + (random() - 0.5) * rough }));
    const sim = forceSimulation(simNodes)
      .randomSource(random)
      .force('collide', forceCollide<N>(d => d.star.r + PAD).iterations(2))
      .force('x', forceX<N>(centre.x).strength(0.08))
      .force('y', forceY<N>(centre.y).strength(0.08))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    let r = 0;
    for (const n of simNodes) {
      n.star.x = round(n.x!); n.star.y = round(n.y!);
      r = Math.max(r, Math.hypot(n.star.x - centre.x, n.star.y - centre.y) + n.star.r);
    }
    layout.clusters.set(key, { key, x: centre.x, y: centre.y, r: r + MARGIN });
    layout.edges.set(key, spanningTree(simNodes.map(n => n.star)));
  }
  return layout;
}

/** Adds a file that appeared later. Existing stars and cluster centres never move. */
export function addNode(layout: Layout, node: GraphNode): StarLayout {
  const existing = layout.stars.get(node.path);
  if (existing) return existing;
  const key = clusterKey(node.path);
  const r = starRadius(node.loc);
  let cluster = layout.clusters.get(key);
  if (!cluster) {
    const centre = placeCluster([...layout.clusters.values()], estimate(4), key);
    cluster = { key, x: centre.x, y: centre.y, r: r + MARGIN };
    layout.clusters.set(key, cluster);
    layout.edges.set(key, []);
    const star = { path: node.path, cluster: key, x: centre.x, y: centre.y, r };
    layout.stars.set(node.path, star);
    return star;
  }
  const siblings = [...layout.stars.values()].filter(s => s.cluster === key);
  const angle0 = seeded(hash(node.path))() * Math.PI * 2;
  let x = cluster.x, y = cluster.y;
  for (let d = 0; d < 5000; d += 3) {
    x = round(cluster.x + Math.cos(angle0 + d * 0.21) * d);
    y = round(cluster.y + Math.sin(angle0 + d * 0.21) * d);
    if (siblings.every(s => Math.hypot(s.x - x, s.y - y) >= s.r + r + PAD * 1.8)) break;
  }
  const star = { path: node.path, cluster: key, x, y, r };
  layout.stars.set(node.path, star);
  cluster.r = Math.max(cluster.r, Math.hypot(x - cluster.x, y - cluster.y) + r + MARGIN);
  if (siblings.length) {
    let nearest = siblings[0];
    for (const s of siblings) if (Math.hypot(s.x - x, s.y - y) < Math.hypot(nearest.x - x, nearest.y - y)) nearest = s;
    layout.edges.get(key)!.push([nearest.path, node.path]);
  }
  return star;
}

export function bounds(layout: Layout) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of layout.clusters.values()) {
    minX = Math.min(minX, c.x - c.r); maxX = Math.max(maxX, c.x + c.r);
    minY = Math.min(minY, c.y - c.r - 18); maxY = Math.max(maxY, c.y + c.r);
  }
  if (!Number.isFinite(minX)) return { minX: -200, minY: -150, maxX: 200, maxY: 150 };
  return { minX, minY, maxX, maxY };
}

const round = (v: number) => Math.round(v * 100) / 100;
