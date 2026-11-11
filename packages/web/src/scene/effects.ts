import { drawGlow, rgba } from './sprites';

export interface Vec { x: number; y: number }
export interface View {
  scale: number; ox: number; oy: number; w: number; h: number;
  presenting: boolean; reduced: boolean;
}
export const toScreen = (v: View, p: Vec): Vec => ({ x: p.x * v.scale + v.ox, y: p.y * v.scale + v.oy });

/** One running effect. `t` runs from 0 to 1; the engine removes it when done. */
export interface Effect { kind?: string; start: number; duration: number; draw(ctx: CanvasRenderingContext2D, t: number, view: View, now: number): void }

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
type At = Vec | (() => Vec | null);
const resolve = (at: At) => (typeof at === 'function' ? at() : at);

/** A thin ring that pulses out from a point. Radii are in screen pixels. */
export function ring(start: number, duration: number, at: At, color: string, opts: { from?: number; to?: number; width?: number; alpha?: number } = {}): Effect {
  const { from = 4, to = 26, width = 1.2, alpha = 0.55 } = opts;
  return {
    kind: 'ring',
    start, duration, draw(ctx, t, view) {
      const p = resolve(at); if (!p) return;
      const s = toScreen(view, p);
      ctx.globalAlpha = alpha * (1 - t);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.arc(s.x, s.y, from + (Math.min(to, 70) - from) * easeOut(t), 0, Math.PI * 2); ctx.stroke();
    },
  };
}

/** Sonar: two rings expanding to a radius in world units. */
export function sonar(start: number, at: Vec, worldRadius: number, color: string): Effect {
  return {
    kind: 'sonar',
    start, duration: 1100, draw(ctx, t, view) {
      const s = toScreen(view, at);
      for (const lag of [0]) {
        const k = (t - lag) / (1 - lag); if (k <= 0) continue;
        ctx.globalAlpha = 0.18 * (1 - k);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 6 + worldRadius * view.scale * easeOut(k), 0, Math.PI * 2); ctx.stroke();
      }
    },
  };
}

/** A glow that blooms and fades. Size in screen pixels. */
export function flash(start: number, duration: number, at: At, color: string, size: number, alpha = 1): Effect {
  return {
    kind: 'flash',
    start, duration, draw(ctx, t, view) {
      const p = resolve(at); if (!p) return;
      const s = toScreen(view, p);
      drawGlow(ctx, color, s.x, s.y, Math.min(size, 36) * (0.8 + 0.2 * easeOut(t)), alpha * 0.22 * (1 - t));
    },
  };
}

export interface Curve { a: Vec; c: Vec; b: Vec }
export const bezier = (q: Curve, t: number): Vec => ({
  x: (1 - t) * (1 - t) * q.a.x + 2 * (1 - t) * t * q.c.x + t * t * q.b.x,
  y: (1 - t) * (1 - t) * q.a.y + 2 * (1 - t) * t * q.c.y + t * t * q.b.y,
});

/** A bright comet running along a curve (world coords) that may move while it runs. */
export function pulseAlong(start: number, duration: number, curve: () => Curve | null, color: string, reverse: boolean): Effect {
  return {
    kind: 'pulseAlong',
    start, duration, draw(ctx, t, view) {
      const q = curve(); if (!q) return;
      const k = 0.5 - Math.cos(Math.PI * Math.min(1, t * 1.1)) / 2;
      const fade = t > 0.9 ? (1 - t) / 0.1 : 1;
      for (let i = 11; i >= 0; i--) {
        const u = k - i * 0.022; if (u < 0) continue;
        const p = toScreen(view, bezier(q, reverse ? 1 - u : u));
        const f = 1 - i / 12;
        drawGlow(ctx, color, p.x, p.y, 16 * f, 0.4 * f * fade);
      }
      const p = toScreen(view, bezier(q, reverse ? 1 - k : k));
      drawGlow(ctx, color, p.x, p.y, 24, 0.3 * fade);
      drawGlow(ctx, '#FFFFFF', p.x, p.y, 8, 0.7 * fade);
    },
  };
}
