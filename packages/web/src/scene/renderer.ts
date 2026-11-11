import { bounds } from './layout';
import type { Scene, SceneAgent, Star } from './model';
import { TRAIL } from './model';
import { bezier, easeOut, toScreen, type View } from './effects';
import { COLLISION_CORE, COLLISION_RING, RESOLVED, STAR, drawGlow, mix, renderBackground, rgba } from './sprites';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export interface Padding { left: number; right: number; top: number; bottom: number }

/** One canvas, one requestAnimationFrame loop. Draws the scene in the spec's order. */
export class Renderer {
  view: View = { scale: 1, ox: 0, oy: 0, w: 1, h: 1, presenting: false, reduced: false };
  padding: Padding = { left: 300, right: 360, top: 90, bottom: 60 };
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private bg?: HTMLCanvasElement;
  private fitVersion = -1;
  private target = { scale: 1, ox: 0, oy: 0 };
  private raf = 0;
  private lastFrame = 0;
  /** Frame times in ms, for the performance check. */
  frameTimes: number[] = [];
  /** Freezes the canvas on its last frame. Used by the screenshot script to capture an exact moment. */
  paused = false;

  constructor(private canvas: HTMLCanvasElement, private scene: Scene) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  start() {
    const loop = (now: number) => { if (!this.paused) this.frame(now); else this.lastFrame = 0; this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.view.w = w; this.view.h = h;
    this.bg = renderBackground(w, h, this.dpr);
    this.fitVersion = -1;
  }

  private fit(snap: boolean) {
    const b = bounds(this.scene.layout);
    const { left, right, top, bottom } = this.padding;
    const aw = Math.max(200, this.view.w - left - right), ah = Math.max(160, this.view.h - top - bottom);
    const bw = b.maxX - b.minX + 120, bh = b.maxY - b.minY + 100;
    const scale = Math.min(aw / bw, ah / bh, 2.2);
    this.target = { scale, ox: left + aw / 2 - ((b.minX + b.maxX) / 2) * scale, oy: top + ah / 2 - ((b.minY + b.maxY) / 2) * scale };
    if (snap) Object.assign(this.view, this.target);
  }

  frame(now: number) {
    if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 600) this.frameTimes.shift(); }
    this.lastFrame = now;
    const { scene, view, ctx } = this;
    scene.reduced = view.reduced;
    if (this.fitVersion !== scene.layoutVersion) { this.fit(this.fitVersion === -1); this.fitVersion = scene.layoutVersion; }
    // Ease the camera so a growing map never jumps.
    const k = 0.06;
    view.scale += (this.target.scale - view.scale) * k;
    view.ox += (this.target.ox - view.ox) * k;
    view.oy += (this.target.oy - view.oy) * k;
    scene.update(now);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // A quiet drafting surface keeps activity signals distinct.
    if (this.bg) ctx.drawImage(this.bg, 0, 0, view.w, view.h);

    const starScale = Math.min(1.9, Math.max(0.8, view.scale));
    const labelSize = view.presenting ? 15 : 12;
    const busy = new Set<string>();
    for (const a of scene.agents.values()) { if (a.focus) busy.add(a.focus); if (a.holding) busy.add(a.holding); }

    // Folder labels anchor the map without decorative halos.
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = `600 ${view.presenting ? 16 : 12}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const c of scene.layout.clusters.values()) {
      const p = toScreen(view, c);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#A6A396';
      ctx.fillText(c.key === '.' ? '(root)' : c.key, p.x, p.y - c.r * view.scale - 4);
    }

    // 3. Constellation lines.
    ctx.globalAlpha = 0.12; ctx.strokeStyle = STAR; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const edges of scene.layout.edges.values()) for (const [a, b] of edges) {
      const sa = scene.stars.get(a), sb = scene.stars.get(b);
      if (!sa || !sb || now < sa.bornAt || now < sb.bornAt) continue;
      const pa = toScreen(view, sa.layout), pb = toScreen(view, sb.layout);
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // 4. Stars.
    const labels: { star: Star; color: string }[] = [];
    for (const s of scene.stars.values()) {
      const drawn = this.drawStar(s, now, starScale);
      if (drawn && (s.tint || s.contested || busy.has(s.layout.path))) labels.push({ star: s, color: drawn });
    }

    // 5. Flight plans.
    for (const a of scene.agents.values()) this.drawPlan(a, now);

    // Tethers sit under the lights.
    this.drawTethers(now);

    // 6. Agent trails and heads.
    for (const a of scene.agents.values()) this.drawAgent(a, now);

    // 7. Effects.
    ctx.globalCompositeOperation = 'lighter';
    for (const e of scene.effects) {
      if (now < e.start) continue;
      e.draw(ctx, Math.min(1, (now - e.start) / e.duration), view, now);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Labels last so they stay readable.
    ctx.font = `${labelSize}px ${MONO}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Skip labels that would overlap a pilot name or a more important label.
    const boxes: [number, number, number, number][] = [];
    for (const a of scene.agents.values()) { const h = toScreen(view, a.pos); boxes.push([h.x + 10, h.y - 22, 90, 18]); }
    const rank = (x: Star) => (x.contested ? 0 : busy.has(x.layout.path) ? 1 : 2);
    labels.sort((a, b) => rank(a.star) - rank(b.star));
    for (const { star, color } of labels) {
      const p = toScreen(view, star.layout);
      const name = star.layout.path.split('/').pop()!;
      const width = ctx.measureText(name).width;
      const right = p.x + star.layout.r * starScale + 7;
      const options: [number, string][] = [[right, 'left'], [p.x - star.layout.r * starScale - 7, 'right']];
      let placed: [number, string] | null = null;
      for (const [x, align] of options) {
        const bx = align === 'left' ? x : x - width;
        const box: [number, number, number, number] = [bx - 2, p.y - labelSize / 2 - 2, width + 4, labelSize + 4];
        if (!boxes.some(b => box[0] < b[0] + b[2] && box[0] + box[2] > b[0] && box[1] < b[1] + b[3] && box[1] + box[3] > b[1])) { boxes.push(box); placed = [x, align]; break; }
      }
      if (!placed) continue;
      ctx.textAlign = placed[1] as CanvasTextAlign;
      const x = placed[0], y = p.y + 1;
      ctx.globalAlpha = star.contested ? 1 : 0.85;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(36,37,34,0.95)'; ctx.strokeText(name, x, y);
      ctx.fillStyle = star.contested ? COLLISION_CORE : color; ctx.fillText(name, x, y);
    }
    ctx.globalAlpha = 1;
  }

  /** Returns the label colour, or null when the star is not visible yet. */
  private drawStar(s: Star, now: number, starScale: number): string | null {
    const { ctx, view, scene } = this;
    if (now < s.bornAt) return null;
    const p = toScreen(view, s.layout);
    if (p.x < -40 || p.y < -40 || p.x > view.w + 40 || p.y > view.h + 40) return null;
    let r = s.layout.r * starScale;
    const born = Math.min(1, (now - s.bornAt) / (s.bornCreate ? 700 : 400));
    if (born < 1) r *= s.bornCreate ? easeOut(born) * (1 + 0.6 * Math.sin(Math.PI * born)) : 1;
    const fade = s.bornCreate ? 1 : born;
    const tw = 1;
    const tint = scene.tintAt(s, now);
    const color = tint.t >= 1 ? tint.color ?? STAR : mix(tint.from ?? STAR, tint.color ?? STAR, tint.t);
    const held = (tint.color ?? tint.from) !== null;
    const contest = s.contested ? Math.min(1, (now - s.contestedAt) / 300) * (s.contestEndAt > -1e11 ? Math.max(0, 1 - (now - s.contestEndAt) / 500) : 1) : 0;
    const deleted = s.deleted && now >= s.deletedAt ? Math.min(1, (now - s.deletedAt) / 600) : 0;

    ctx.globalCompositeOperation = 'lighter';
    // Halo in the holder's colour.
    if (held) {
      const w = tint.color ? (tint.from ? 1 : tint.t) : 1 - tint.t;
      if (tint.from && tint.t < 1) drawGlow(ctx, tint.from, p.x, p.y, r * 8, 0.3 * (1 - tint.t) * (1 - deleted));
      if (tint.color) drawGlow(ctx, tint.color, p.x, p.y, r * 8, 0.3 * (tint.from ? tint.t : w) * (1 - deleted));
    } else {
      drawGlow(ctx, STAR, p.x, p.y, r * 5, 0.1 * tw * fade * (1 - deleted * 0.8));
    }
    ctx.globalCompositeOperation = 'source-over';

    // Core.
    ctx.globalAlpha = (held ? 1 : 0.7 * tw) * fade;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (deleted > 0) {
      ctx.globalAlpha = (1 - deleted) * 0.9 + deleted * 0.45;
      ctx.lineWidth = 1.2; ctx.strokeStyle = color; ctx.stroke();
      if (deleted < 1) { ctx.globalAlpha *= 1 - deleted; ctx.fillStyle = color; ctx.fill(); }
    } else {
      ctx.fillStyle = contest > 0 ? mix(color, COLLISION_CORE, contest * (this.isAccepted(s.contested!) ? 0.4 : 0.9)) : color;
      ctx.fill();
    }

    // Collision: red and white double ring, readable without colour by its shape.
    if (contest > 0) {
      const calm = this.isAccepted(s.contested!);
      const breathe = 0;
      // Once a split is accepted the double ring settles into one thin green ring.
      const settled = calm ? Math.min(1, (now - (this.scene.collisions.get(s.contested!)?.acceptedAt ?? 0)) / 800) : 0;
      ctx.globalAlpha = contest * (1 - settled);
      ctx.lineWidth = 2.5; ctx.strokeStyle = COLLISION_RING;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 7 + breathe, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = COLLISION_CORE;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 12 + breathe, 0, Math.PI * 2); ctx.stroke();
      if (settled > 0) {
        ctx.globalAlpha = contest * settled * 0.7;
        ctx.lineWidth = 1.2; ctx.strokeStyle = RESOLVED;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // Split preview: a half-ring in the proposed owner's colour.
    if (s.preview) {
      const t = Math.min(1, (now - s.previewAt) / 500);
      const rr = r + (s.previewStrong ? 18 : 9);
      ctx.globalAlpha = t * (s.previewStrong ? 1 : 0.75);
      ctx.lineWidth = s.previewStrong ? 3.5 : 2; ctx.strokeStyle = s.preview; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * easeOut(t)); ctx.stroke();
      ctx.lineCap = 'butt';
    }
    ctx.globalAlpha = 1;
    return held ? (tint.color ?? tint.from ?? STAR) : '#D9D5C9';
  }

  private isAccepted(collisionId: string) {
    const c = this.scene.collisions.get(collisionId);
    return !!c && c.acceptedAt !== null;
  }

  private drawPlan(a: SceneAgent, now: number) {
    const { ctx, view, scene } = this;
    if (!a.plan) return;
    const pts = a.plan.paths.map(p => scene.stars.get(p)).filter((s): s is Star => !!s).map(s => toScreen(view, s.layout));
    if (pts.length < 1) return;
    const fadeOut = a.plan.fadeAt !== null ? Math.max(0, 1 - (now - a.plan.fadeAt) / 1200) : 1;
    if (fadeOut <= 0) { a.plan = null; return; }
    const age = now - a.plan.start;
    const draw = Math.min(1, age / 900);
    const settle = age < 900 ? 0.95 : Math.max(0.42, 0.95 - (age - 900) / 1500);
    const alpha = settle * fadeOut * this.scene.alpha(a, now);
    // Sample a smooth path from the light through each predicted star.
    const head = toScreen(view, a.pos);
    const all = [age < 900 ? head : pts[0], ...pts.slice(age < 900 ? 0 : 1)];
    const samples: { x: number; y: number }[] = [all[0]];
    for (let i = 1; i < all.length; i++) {
      const p0 = all[i - 1], p1 = all[i];
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const c = { x: (p0.x + p1.x) / 2 - dy * 0.18, y: (p0.y + p1.y) / 2 + dx * 0.18 };
      for (let k = 1; k <= 12; k++) samples.push(bezier({ a: p0, c, b: p1 }, k / 12));
    }
    let total = 0;
    for (let i = 1; i < samples.length; i++) total += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    const limit = total * easeOut(draw);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = a.color; ctx.lineWidth = view.presenting ? 2.2 : 1.6;
    ctx.setLineDash([7, 7]);
    ctx.lineDashOffset = 0;
    ctx.beginPath(); ctx.moveTo(samples[0].x, samples[0].y);
    let run = 0;
    for (let i = 1; i < samples.length; i++) {
      const seg = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      if (run + seg > limit) { const f = (limit - run) / seg; ctx.lineTo(samples[i - 1].x + (samples[i].x - samples[i - 1].x) * f, samples[i - 1].y + (samples[i].y - samples[i - 1].y) * f); break; }
      run += seg; ctx.lineTo(samples[i].x, samples[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Waypoint marks on each predicted star once the path reaches it.
    ctx.lineWidth = 1.2;
    let reach = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 || age < 900) reach += 1;
      if (draw < 1 && reach / all.length > draw + 0.05) break;
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 9, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  private drawTethers(now: number) {
    const { ctx, view, scene } = this;
    for (const c of scene.collisions.values()) {
      const q = scene.tether(c);
      if (!q) continue;
      const form = Math.min(1, (now - c.tetherAt) / 700);
      const end = c.tetherEndAt === null ? 1 : Math.max(0, 1 - (now - c.tetherEndAt) / 700);
      if (end <= 0) continue;
      const a = toScreen(view, q.a), b = toScreen(view, q.b), m = toScreen(view, q.c);
      const breathe = 1;
      // Draw in from both ends towards the middle.
      const half = easeOut(form) * 0.5;
      const path = (from: number, to: number) => {
        ctx.beginPath();
        for (let i = 0; i <= 20; i++) {
          const t = from + (to - from) * (i / 20);
          const p = bezier({ a, c: m, b }, t);
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
      };
      ctx.save();
      if (c.tetherEndAt !== null) ctx.setLineDash([3 + 10 * (1 - end), 4 + 12 * (1 - end)]);
      ctx.globalCompositeOperation = 'lighter';
      for (const [w, col, al] of [[2, COLLISION_RING, 0.7], [0.7, COLLISION_CORE, 0.5]] as const) {
        ctx.lineWidth = w; ctx.strokeStyle = col; ctx.globalAlpha = al * end * breathe;
        path(0, half); ctx.stroke();
        path(1, 1 - half); ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawAgent(a: SceneAgent, now: number) {
    const { ctx, view, scene } = this;
    const alpha = scene.alpha(a, now);
    if (alpha <= 0.01) return;
    const head = toScreen(view, a.pos);
    ctx.globalCompositeOperation = 'lighter';
    // Trail: ring buffer of the last 40 head positions, falling opacity.
    if (a.trailCount > 1) {
      ctx.strokeStyle = a.color; ctx.lineCap = 'round';
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < a.trailCount; i++) {
        const idx = ((a.trailHead - a.trailCount + i + TRAIL) % TRAIL) * 2;
        const p = toScreen(view, { x: a.trail[idx], y: a.trail[idx + 1] });
        if (prev) {
          const f = i / a.trailCount;
          ctx.globalAlpha = f * f * 0.3 * alpha;
          ctx.lineWidth = 0.6 + f * 1.5;
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
        prev = p;
      }
      ctx.lineCap = 'butt';
    }
    drawGlow(ctx, a.color, head.x, head.y, view.presenting ? 40 : 32, alpha * 0.35);
    drawGlow(ctx, a.color, head.x, head.y, 18, alpha * 0.4);
    
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(head.x, head.y, 4, 0, Math.PI * 2); ctx.fill();
    // Command ring spins while a command runs.
    if (a.command) {
      const ang = view.reduced ? 0 : (now - a.command.start) * 0.002;
      ctx.strokeStyle = a.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(head.x, head.y, 15, ang, ang + Math.PI * 1.35); ctx.stroke();
      ctx.globalAlpha = alpha * 0.35;
      ctx.beginPath(); ctx.arc(head.x, head.y, 15, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    // Holding: a dashed guard ring so "on hold" reads without colour.
    if (a.holding) {
      ctx.strokeStyle = rgba(COLLISION_RING, 0.9); ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(head.x, head.y, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = `600 ${view.presenting ? 17 : 12}px ${SANS}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(36,37,34,0.95)'; ctx.lineJoin = 'round';
    ctx.strokeText(a.pilot, head.x + 14, head.y - 13);
    ctx.fillStyle = a.color; ctx.fillText(a.pilot, head.x + 14, head.y - 13);
    ctx.globalAlpha = 1;
  }
}
