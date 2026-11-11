import { displayColor } from '../palette';
import type { TowerEvent } from '@tower/shared';
import { addNode, bounds, clusterKey, layoutGraph, type GraphNode, type Layout, type StarLayout } from './layout';
import { enqueue, minTime, pace, type Beat } from './beats';
import { flash, pulseAlong, ring, sonar, type Curve, type Effect, type Vec } from './effects';
import { hash, seeded } from './rng';
import { COLLISION_CORE, COLLISION_RING, RESOLVED } from './sprites';

type Behavior =
  | { kind: 'orbit'; cx: number; cy: number; r: number; phase: number; speed: number }
  | { kind: 'dock'; path: string; phase: number }
  | { kind: 'hold'; path: string; r: number; phase: number }
  | { kind: 'point'; x: number; y: number };

export interface Star {
  layout: StarLayout;
  tw: number; twSpeed: number;
  tint: string | null; owner: string | null; prevTint: string | null; tintAt: number; tintDur: number;
  flareAt: number; bornAt: number; bornCreate: boolean;
  deleted: boolean; deletedAt: number;
  contested: string | null; contestedAt: number; contestEndAt: number;
  preview: string | null; previewStrong: boolean; previewAt: number;
}

export interface SceneAgent {
  id: string; pilot: string; color: string; index: number;
  alphaFrom: number; alphaTo: number; alphaAt: number; alphaDur: number;
  behavior: Behavior;
  move: { from: Vec; ctrl: Vec; start: number; dur: number } | null;
  next: { at: number; behavior: Behavior; dur: number } | null;
  pos: Vec;
  trail: Float32Array; trailHead: number; trailCount: number;
  queue: Beat[]; until: number;
  command: { start: number; kind: string } | null;
  plan: { paths: string[]; start: number; fadeAt: number | null } | null;
  focus: string | null;
  holding: string | null;
  lastCluster: string | null;
  leftAt: number | null;
  random: () => number;
}

export interface SceneCollision {
  id: string; agents: [string, string]; files: string[];
  openedAt: number; acceptedAt: number | null; resolvedAt: number | null;
  tetherAt: number; tetherEndAt: number | null;
  split: { agentId: string; files: string[] }[] | null;
}

export const TRAIL = 40;
const NEVER = -1e12;

export class Scene {
  layout: Layout = layoutGraph([]);
  repoId = '';
  stars = new Map<string, Star>();
  agents = new Map<string, SceneAgent>();
  collisions = new Map<string, SceneCollision>();
  effects: Effect[] = [];
  reduced = false;
  /** Bumped when the layout grows, so the renderer refits the camera. */
  layoutVersion = 0;
  private joinCount = 0;
  private system: Beat[] = [];
  private systemUntil = 0;

  reset(graph: { repoId: string; nodes: GraphNode[] }, now: number) {
    const otherRepo = graph.repoId && this.repoId && graph.repoId !== this.repoId;
    if (otherRepo || this.stars.size === 0) {
      // Full seeded layout. Later files are added incrementally so nothing moves.
      this.layout = layoutGraph(graph.nodes);
      this.stars.clear();
      for (const s of this.layout.stars.values()) this.stars.set(s.path, this.newStar(s, NEVER));
    } else {
      // The phase 1 server rebuilds its graph from scratch on reset. Known stars stay put.
      for (const n of graph.nodes) this.ensureStar(n.path, NEVER, n.loc);
    }
    this.repoId = graph.repoId || this.repoId;
    for (const s of this.stars.values()) Object.assign(s, this.newStar(s.layout, NEVER), { tw: s.tw, twSpeed: s.twSpeed });
    this.agents.clear(); this.collisions.clear(); this.effects = []; this.system = [];
    this.joinCount = 0; this.layoutVersion++;
    void now;
  }

  /** Live events animate as beats. Replayed events (after a reload) set state with no animation. */
  ingest(event: TowerEvent, live: boolean, now: number) {
    if (event.type === 'agent.joined' && !this.agents.has(event.agentId)) this.agents.set(event.agentId, this.newAgent(event));
    const beat: Beat = { event, min: minTime(event) };
    if (!live) { this.begin(event, now, 0, true); return; }
    if (event.type === 'hold.applied') {
      // The bounce belongs to the held agent, so it plays alongside the collision beat.
      const c = this.collisions.get(event.data.collisionId);
      const held = c && this.agents.get(c.agents.find(id => id !== event.data.heldBy) ?? '');
      if (held) { held.queue = enqueue(held.queue, beat); return; }
    }
    if (event.agentId === 'system') { this.system = enqueue(this.system, beat); return; }
    const agent = this.agents.get(event.agentId);
    if (!agent) { this.begin(event, now, 0, false); return; }
    agent.queue = enqueue(agent.queue, beat);
  }

  update(now: number) {
    for (const a of this.agents.values()) {
      // A long backlog (a hidden tab, say) is applied instantly so we stay in sync.
      while (a.queue.length > 24) this.begin(a.queue.shift()!.event, now, 0, true);
      while (a.queue.length && now >= a.until) {
        const beat = a.queue.shift()!;
        const dur = beat.min * pace(a.queue.length + 1);
        a.until = now + dur;
        this.begin(beat.event, now, dur, false);
      }
      if (a.next && now >= a.next.at) { this.go(a, a.next.behavior, a.next.dur, now); a.next = null; }
      a.pos = this.position(a, now);
      const i = a.trailHead * 2;
      a.trail[i] = a.pos.x; a.trail[i + 1] = a.pos.y;
      a.trailHead = (a.trailHead + 1) % TRAIL;
      a.trailCount = Math.min(TRAIL, a.trailCount + 1);
      if (a.leftAt !== null && now > a.leftAt + 900) this.agents.delete(a.id);
    }
    while (this.system.length > 24) this.begin(this.system.shift()!.event, now, 0, true);
    while (this.system.length && now >= this.systemUntil) {
      const beat = this.system.shift()!;
      const dur = beat.min * pace(this.system.length + 1);
      this.systemUntil = now + dur;
      this.begin(beat.event, now, dur, false);
    }
    for (const [id, c] of this.collisions) if (c.resolvedAt !== null && now > c.resolvedAt + 800) this.collisions.delete(id);
    for (const s of this.stars.values()) if (s.contested && s.contestEndAt !== NEVER && now > s.contestEndAt + 600) { s.contested = null; s.contestEndAt = NEVER; }
    this.effects = this.effects.filter(e => now < e.start + e.duration);
  }

  alpha(a: SceneAgent, now: number) {
    const t = a.alphaDur ? Math.min(1, Math.max(0, (now - a.alphaAt) / a.alphaDur)) : 1;
    return a.alphaFrom + (a.alphaTo - a.alphaFrom) * t;
  }

  tintAt(s: Star, now: number): { color: string | null; from: string | null; t: number } {
    if (now < s.tintAt) return { color: s.prevTint, from: s.prevTint, t: 1 };
    const t = Math.min(1, (now - s.tintAt) / s.tintDur);
    return { color: s.tint, from: s.prevTint, t };
  }

  center(): Vec {
    const b = bounds(this.layout);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }

  tether(c: SceneCollision): Curve | null {
    const a = this.agents.get(c.agents[0]), b = this.agents.get(c.agents[1]);
    if (!a || !b) return null;
    const mx = (a.pos.x + b.pos.x) / 2, my = (a.pos.y + b.pos.y) / 2;
    const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
    return { a: a.pos, b: b.pos, c: { x: mx - dy * 0.2, y: my + dx * 0.2 } };
  }

  // ---------------------------------------------------------------------------

  private newStar(layout: StarLayout, bornAt: number): Star {
    const r = seeded(hash(layout.path));
    return {
      layout, tw: r() * Math.PI * 2, twSpeed: 0.6 + r() * 1.2,
      tint: null, owner: null, prevTint: null, tintAt: NEVER, tintDur: 1,
      flareAt: NEVER, bornAt, bornCreate: false, deleted: false, deletedAt: NEVER,
      contested: null, contestedAt: NEVER, contestEndAt: NEVER,
      preview: null, previewStrong: false, previewAt: NEVER,
    };
  }

  private ensureStar(path: string, now: number, loc = 0): Star {
    let star = this.stars.get(path);
    if (star) return star;
    const parts = path.split('/');
    const layout = addNode(this.layout, { path, dir: parts.slice(0, -1).join('/') || '.', loc, ext: path.includes('.') ? path.split('.').pop()! : '' });
    star = this.newStar(layout, now);
    this.stars.set(path, star);
    this.layoutVersion++;
    return star;
  }

  private newAgent(event: Extract<TowerEvent, { type: 'agent.joined' }>): SceneAgent {
    const { agent } = event.data;
    const index = this.joinCount++;
    const random = seeded(hash(agent.id));
    const c = this.center();
    return {
      id: agent.id, pilot: agent.pilot, color: displayColor(agent.color), index,
      alphaFrom: 0, alphaTo: 0, alphaAt: 0, alphaDur: 0,
      behavior: { kind: 'point', x: c.x, y: c.y }, move: null, next: null, pos: { ...c },
      trail: new Float32Array(TRAIL * 2), trailHead: 0, trailCount: 0,
      queue: [], until: 0, command: null, plan: null, focus: null, holding: null,
      lastCluster: null, leftAt: null, random,
    };
  }

  private orbitAround(a: SceneAgent, cluster: string | null): Behavior {
    const c = cluster ? this.layout.clusters.get(cluster) : undefined;
    if (c) return { kind: 'orbit', cx: c.x, cy: c.y, r: c.r * 0.75 + 16 + a.index * 9, phase: a.random() * Math.PI * 2, speed: 0.00016 * (a.index % 2 ? -1 : 1) };
    const centre = this.center();
    const b = bounds(this.layout);
    const r = Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3 + 30 + a.index * 26;
    return { kind: 'orbit', cx: centre.x, cy: centre.y, r, phase: a.index * 2.1 + 0.4, speed: 0.00011 * (a.index % 2 ? -1 : 1) };
  }

  private behaviorPos(b: Behavior, now: number): Vec {
    switch (b.kind) {
      case 'orbit': {
        const ang = b.phase + now * b.speed * (this.reduced ? 0.4 : 1);
        return { x: b.cx + Math.cos(ang) * b.r * 1.3, y: b.cy + Math.sin(ang) * b.r * 0.8 };
      }
      case 'dock': {
        const s = this.stars.get(b.path);
        if (!s) return { x: 0, y: 0 };
        const bob = this.reduced ? 0 : Math.sin(now * 0.003 + b.phase) * 1.6;
        return { x: s.layout.x + 9, y: s.layout.y - 9 + bob };
      }
      case 'hold': {
        const s = this.stars.get(b.path);
        if (!s) return { x: 0, y: 0 };
        const ang = b.phase + now * 0.0017;
        return { x: s.layout.x + Math.cos(ang) * b.r, y: s.layout.y + Math.sin(ang) * b.r };
      }
      case 'point': return { x: b.x, y: b.y };
    }
  }

  private position(a: SceneAgent, now: number): Vec {
    const end = this.behaviorPos(a.behavior, now);
    if (!a.move || now >= a.move.start + a.move.dur) { a.move = null; return end; }
    const t = Math.max(0, (now - a.move.start) / a.move.dur);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const { from, ctrl } = a.move;
    return {
      x: (1 - k) * (1 - k) * from.x + 2 * (1 - k) * k * ctrl.x + k * k * end.x,
      y: (1 - k) * (1 - k) * from.y + 2 * (1 - k) * k * ctrl.y + k * k * end.y,
    };
  }

  /** Eased quadratic curve from where the light is now, with a random perpendicular offset. */
  private go(a: SceneAgent, behavior: Behavior, dur: number, now: number, instant = false) {
    a.behavior = behavior;
    a.next = null;
    if (instant || dur <= 0) { a.move = null; a.pos = this.behaviorPos(behavior, now); return; }
    const from = { ...a.pos };
    const to = this.behaviorPos(behavior, now + dur);
    const dx = to.x - from.x, dy = to.y - from.y;
    const bend = (a.random() - 0.5) * 0.7;
    a.move = { from, ctrl: { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend }, start: now, dur };
  }

  private setTint(s: Star, color: string | null, owner: string | null, at: number, dur: number) {
    const current = this.tintAt(s, at);
    s.prevTint = current.t >= 1 ? current.color : current.from;
    s.tint = color; s.owner = owner; s.tintAt = at; s.tintDur = Math.max(1, dur);
  }

  private fx(...effects: Effect[]) { this.effects.push(...effects); }

  private begin(event: TowerEvent, now: number, dur: number, instant: boolean) {
    const a = this.agents.get(event.agentId);
    const live = !instant;
    switch (event.type) {
      case 'agent.joined': {
        if (!a) return;
        a.color = displayColor(event.data.agent.color); a.pilot = event.data.agent.pilot;
        const orbit = this.orbitAround(a, null);
        if (instant) { a.alphaFrom = a.alphaTo = 1; this.go(a, orbit, 0, now, true); return; }
        const centre = this.center();
        const b = bounds(this.layout);
        const ang = (hash(a.id) % 628) / 100;
        const reach = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.75 + 80;
        a.pos = { x: centre.x + Math.cos(ang) * reach, y: centre.y + Math.sin(ang) * reach * 0.6 };
        a.trailCount = 0;
        Object.assign(a, { alphaFrom: 0, alphaTo: 1, alphaAt: now, alphaDur: dur });
        this.go(a, orbit, dur * 1.6, now);
        return;
      }
      case 'agent.left': {
        if (!a) return;
        for (const s of this.stars.values()) if (s.owner === a.id) this.setTint(s, null, null, now, instant ? 1 : 3000);
        a.plan = null; a.command = null;
        if (instant) { this.agents.delete(a.id); return; }
        Object.assign(a, { alphaFrom: this.alpha(a, now), alphaTo: 0, alphaAt: now, alphaDur: dur, leftAt: now });
        return;
      }
      case 'agent.status': {
        if (!a) return;
        if (event.data.status === 'idle') {
          this.go(a, this.orbitAround(a, a.lastCluster), 1400, now, instant);
          a.focus = null; a.holding = null;
          if (a.plan) a.plan.fadeAt = instant ? NEVER : now;
          if (instant) a.plan = null;
        }
        if (event.data.status === 'working' && a.holding) { a.holding = null; this.go(a, this.orbitAround(a, a.lastCluster), 900, now, instant); }
        return;
      }
      case 'intent.declared': {
        if (!a || !event.data.predictedFiles.length) return;
        for (const p of event.data.predictedFiles) this.ensureStar(p, now);
        a.plan = { paths: event.data.predictedFiles, start: instant ? NEVER : now, fadeAt: null };
        return;
      }
      case 'file.read': {
        const s = this.ensureStar(event.data.path, now);
        if (!a) return;
        a.focus = s.layout.path; a.lastCluster = s.layout.cluster; a.holding = null;
        const travel = Math.max(120, dur * 0.8);
        this.go(a, { kind: 'dock', path: s.layout.path, phase: a.random() * 6 }, travel, now, instant);
        if (live) this.fx(ring(now + travel, 650, s.layout, a.color, { from: 3, to: 22, width: 1 }));
        return;
      }
      case 'file.search': {
        if (!a || instant) return;
        const scope = event.data.scope ? this.layout.clusters.get(clusterKey(`${event.data.scope}/x`)) : undefined;
        const b = bounds(this.layout);
        const radius = scope ? Math.hypot(scope.x - a.pos.x, scope.y - a.pos.y) + scope.r : Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
        this.fx(sonar(now, { ...a.pos }, radius, a.color));
        return;
      }
      case 'file.edit': {
        const s = this.ensureStar(event.data.path, now);
        const travel = Math.max(150, dur * 0.4);
        const arrive = instant ? NEVER : now + travel;
        if (event.data.op === 'create') { s.bornAt = arrive; s.bornCreate = true; s.deleted = false; }
        else if (event.data.op === 'delete') { s.deleted = true; s.deletedAt = arrive; }
        else s.deleted = false;
        if (!a) return;
        a.focus = s.layout.path; a.lastCluster = s.layout.cluster; a.holding = null;
        this.setTint(s, event.data.op === 'delete' ? null : a.color, event.data.op === 'delete' ? null : a.id, arrive, 260);
        this.go(a, { kind: 'dock', path: s.layout.path, phase: a.random() * 6 }, travel, now, instant);
        if (live) {
          s.flareAt = arrive;
          this.fx(flash(arrive, 700, s.layout, a.color, 110), ring(arrive, 600, s.layout, a.color, { from: 5, to: 34, width: 2 }));
        }
        return;
      }
      case 'command.run': {
        if (a) a.command = { start: now, kind: event.data.kind };
        return;
      }
      case 'command.done': {
        if (!a) return;
        a.command = null;
        if (instant) return;
        const ok = event.data.exitCode === 0;
        const color = !ok ? COLLISION_RING : event.data.kind === 'test' ? RESOLVED : '#FFFFFF';
        const at = () => a.pos;
        this.fx(ring(now, 260, at, color, { from: 20, to: 6, width: 2.5 }), flash(now, 420, at, color, ok && event.data.kind !== 'test' ? 50 : 120));
        return;
      }
      case 'hold.applied': {
        const c = this.collisions.get(event.data.collisionId);
        const heldId = c ? c.agents.find(id => id !== event.data.heldBy) : undefined;
        const held = heldId ? this.agents.get(heldId) : undefined;
        const s = this.ensureStar(event.data.path, now);
        if (!held) return;
        held.holding = s.layout.path; held.focus = s.layout.path;
        const hold: Behavior = { kind: 'hold', path: s.layout.path, r: 44, phase: Math.atan2(held.pos.y - s.layout.y, held.pos.x - s.layout.x) };
        if (instant) { this.go(held, hold, 0, now, true); return; }
        // Fly at the star, bounce off, then circle it at a distance.
        const dx = held.pos.x - s.layout.x, dy = held.pos.y - s.layout.y, d = Math.hypot(dx, dy) || 1;
        const hit = Math.min(280, dur * 0.4);
        this.go(held, { kind: 'point', x: s.layout.x + (dx / d) * 10, y: s.layout.y + (dy / d) * 10 }, hit, now);
        held.next = { at: now + hit, behavior: hold, dur: Math.max(300, dur - hit) };
        this.fx(ring(now + hit, 500, s.layout, COLLISION_RING, { from: 8, to: 30, width: 2.5 }), flash(now + hit, 400, s.layout, COLLISION_CORE, 70));
        return;
      }
      case 'collision.detected': {
        const { collisionId, agentIds, files } = event.data;
        this.collisions.set(collisionId, { id: collisionId, agents: agentIds, files, openedAt: instant ? NEVER : now, acceptedAt: null, resolvedAt: null, tetherAt: instant ? NEVER : now, tetherEndAt: null, split: null });
        const stars = files.map(f => this.ensureStar(f, now));
        for (const s of stars) { s.contested = collisionId; s.contestedAt = instant ? NEVER : now; s.contestEndAt = NEVER; }
        if (instant || !stars.length) return;
        // Persistent double rings and the alert carry the collision signal.
        for (const s of stars) this.fx(ring(now, 900, s.layout, COLLISION_RING, { from: 6, to: 60, width: 3 }), ring(now + 150, 900, s.layout, COLLISION_CORE, { from: 6, to: 46, width: 1.5 }));
        return;
      }
      case 'negotiation.message': {
        const c = this.collisions.get(event.data.collisionId);
        const speaker = this.agents.get(event.data.from);
        if (!c || instant || !speaker) return;
        const reverse = c.agents[1] === event.data.from;
        this.fx(pulseAlong(now, Math.max(500, Math.min(1200, dur * 2.2)), () => this.tether(c), speaker.color, reverse), ring(now, 500, () => speaker.pos, speaker.color, { from: 8, to: 30, width: 2 }));
        return;
      }
      case 'split.proposed': {
        const c = this.collisions.get(event.data.collisionId);
        if (c) c.split = event.data.assignments.map(x => ({ agentId: x.agentId, files: x.files }));
        for (const asg of event.data.assignments) {
          const color = this.agents.get(asg.agentId)?.color ?? '#FFFFFF';
          for (const f of asg.files) {
            const s = this.ensureStar(f, now);
            s.preview = color; s.previewStrong = !!c?.files.includes(f); s.previewAt = instant ? NEVER : now;
            if (live) this.fx(ring(now, 600, s.layout, color, { from: 6, to: 20, width: 1.5 }));
          }
        }
        return;
      }
      case 'split.rejected': {
        const c = this.collisions.get(event.data.collisionId);
        if (c) c.split = null;
        for (const s of this.stars.values()) s.preview = null;
        return;
      }
      case 'split.accepted': {
        const c = this.collisions.get(event.data.collisionId);
        if (!c) return;
        c.acceptedAt = instant ? NEVER : now;
        c.tetherEndAt = instant ? NEVER : now;
        const q = this.tether(c);
        const mid = q ? { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 } : this.center();
        for (const asg of c.split ?? []) {
          const owner = this.agents.get(asg.agentId);
          for (const f of asg.files) {
            const s = this.ensureStar(f, now);
            const delay = Math.min(900, Math.hypot(s.layout.x - mid.x, s.layout.y - mid.y) * 3);
            const at = instant ? NEVER : now + delay;
            this.setTint(s, owner?.color ?? null, owner?.id ?? null, at, 380);
            s.preview = null;
            if (live) { s.flareAt = at; this.fx(flash(at, 800, s.layout, owner?.color ?? RESOLVED, 130), ring(at, 700, s.layout, owner?.color ?? RESOLVED, { from: 6, to: 30, width: 2 })); }
          }
        }
        if (live) this.fx(ring(now, 1800, mid, RESOLVED, { from: 10, to: 70, width: 1.5, alpha: 0.5 }), ring(now + 250, 1800, mid, RESOLVED, { from: 10, to: 50, width: 1, alpha: 0.3 }), flash(now, 1100, mid, RESOLVED, 260, 0.8));
        // The split lets both agents carry on: a held agent flies to the first file it now owns.
        for (const id of c.agents) {
          const x = this.agents.get(id);
          if (!x?.holding) continue;
          x.holding = null;
          const own = c.split?.find(s => s.agentId === id)?.files.find(f => !c.files.includes(f));
          if (own) { x.focus = own; x.lastCluster = this.stars.get(own)?.layout.cluster ?? x.lastCluster; this.go(x, { kind: 'dock', path: own, phase: 0 }, 1100, now, instant); }
          else this.go(x, this.orbitAround(x, x.lastCluster), 1100, now, instant);
        }
        return;
      }
      case 'collision.resolved': {
        const c = this.collisions.get(event.data.collisionId);
        if (!c) return;
        c.resolvedAt = now;
        if (c.tetherEndAt === null) c.tetherEndAt = instant ? NEVER : now;
        for (const s of this.stars.values()) if (s.contested === c.id) { if (instant) s.contested = null; else s.contestEndAt = now; }
        for (const id of c.agents) { const x = this.agents.get(id); if (x?.holding) { x.holding = null; this.go(x, this.orbitAround(x, x.lastCluster), 900, now, instant); } }
        if (instant) this.collisions.delete(c.id);
        else this.fx(...c.files.map(f => ring(now, 700, this.stars.get(f)!.layout, RESOLVED, { from: 8, to: 40, width: 2 })));
        return;
      }
      case 'mail.delivered': {
        const to = this.agents.get(event.data.to);
        if (to && live) this.fx(ring(now, 700, () => to.pos, '#FFFFFF', { from: 6, to: 26, width: 1.5, alpha: 0.7 }), flash(now, 500, () => to.pos, '#FFFFFF', 46, 0.6));
        return;
      }
    }
  }
}
