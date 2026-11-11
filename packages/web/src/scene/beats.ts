import type { TowerEvent } from '@tower/shared';

/** One event turned into movement plus effects, with a minimum screen time. */
export interface Beat { event: TowerEvent; min: number }

export const MAX_BEATS = 8;

/** Minimum screen time per event type, from the spec's event table. */
export function minTime(event: TowerEvent): number {
  switch (event.type) {
    case 'agent.joined': return 800;
    case 'intent.declared': return event.data.predictedFiles.length ? 900 : 0;
    case 'file.read': return 250;
    case 'file.search': return 400;
    case 'file.edit': return 600;
    case 'command.run': return 150;
    case 'command.done': return 300;
    case 'hold.applied': return 700;
    case 'collision.detected': return 1500;
    case 'negotiation.message': return 500;
    case 'split.proposed': return 600;
    case 'split.accepted': return 1200;
    case 'split.rejected': return 400;
    case 'collision.resolved': return 500;
    case 'agent.left': return 800;
    default: return 0;
  }
}

/**
 * Adds a beat. Past MAX_BEATS we drop the oldest reads first, then the oldest searches.
 * Edits, collisions and anything from `system` are never dropped.
 */
export function enqueue(queue: Beat[], beat: Beat): Beat[] {
  const next = [...queue, beat];
  for (const type of ['file.read', 'file.search'] as const) {
    while (next.length > MAX_BEATS) {
      const i = next.findIndex(b => b.event.type === type && b.event.agentId !== 'system');
      if (i < 0) break;
      next.splice(i, 1);
    }
  }
  return next;
}

/** If protected beats still pile up, play them faster so the screen catches up with the server. */
export function pace(queueLength: number): number {
  return queueLength > MAX_BEATS ? 0.4 : queueLength > 4 ? 0.7 : 1;
}
