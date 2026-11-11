import { describe, expect, it } from 'vitest';
import { parseEvent } from '@tower/shared';
import { enqueue, MAX_BEATS, minTime, pace, type Beat } from './beats';

let seq = 0;
const beat = (type: string, data: unknown, agentId = 'sim:a'): Beat => {
  const event = parseEvent({ seq: ++seq, ts: seq, agentId, type, data });
  return { event, min: minTime(event) };
};
const read = (p: string) => beat('file.read', { path: p });
const edit = (p: string) => beat('file.edit', { path: p, op: 'modify' });

describe('beat queue', () => {
  it('drops the oldest reads first once past 8 beats', () => {
    let q: Beat[] = [];
    for (let i = 0; i < 6; i++) q = enqueue(q, read(`r${i}.ts`));
    for (let i = 0; i < 4; i++) q = enqueue(q, edit(`e${i}.ts`));
    expect(q).toHaveLength(MAX_BEATS);
    expect(q.map(b => (b.event.data as { path: string }).path)).toEqual(['r2.ts', 'r3.ts', 'r4.ts', 'r5.ts', 'e0.ts', 'e1.ts', 'e2.ts', 'e3.ts']);
  });
  it('never drops edits or system events', () => {
    let q: Beat[] = [];
    for (let i = 0; i < 10; i++) q = enqueue(q, edit(`e${i}.ts`));
    q = enqueue(q, beat('negotiation.message', { collisionId: 'c', from: 'sim:a', text: 'hi' }, 'system'));
    expect(q).toHaveLength(11);
    expect(pace(q.length)).toBeLessThan(1);
  });
  it('uses the minimum times from the spec', () => {
    expect(read('a.ts').min).toBe(250);
    expect(edit('a.ts').min).toBe(600);
    expect(beat('intent.declared', { text: 'x', predictedFiles: [] }).min).toBe(0);
  });
});
