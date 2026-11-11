// Pre-rendered glow sprites and colour helpers. Nothing here uses shadowBlur.
export const STAR = '#C7C2B7';
export const COLLISION_CORE = '#F0ECE1';
export const COLLISION_RING = '#D08C75';
export const RESOLVED = '#A5B99A';

const SPRITE = 64;
const glows = new Map<string, HTMLCanvasElement>();

export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A soft radial glow in one colour, drawn with drawImage and 'lighter'. */
export function glow(color: string): HTMLCanvasElement {
  let sprite = glows.get(color);
  if (sprite) return sprite;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = SPRITE;
  const ctx = sprite.getContext('2d')!;
  const g = ctx.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  g.addColorStop(0, rgba(color, 1));
  g.addColorStop(0.18, rgba(color, 0.55));
  g.addColorStop(0.45, rgba(color, 0.14));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SPRITE, SPRITE);
  glows.set(color, sprite);
  return sprite;
}

export function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, size: number, alpha: number) {
  if (alpha <= 0.003 || size <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(glow(color), x - size / 2, y - size / 2, size, size);
}

/** Solid warm charcoal surface, rendered once per resize. */
export function renderBackground(w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#242522';
  ctx.fillRect(0, 0, w, h);
  return c;
}

