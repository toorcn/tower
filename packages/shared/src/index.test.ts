import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEvent, reduceState, initialState, TowerEventSchema, EventEnvelopeSchema } from './index.js';
const lines: Record<string, unknown>[] = readFileSync(new URL('../../../scenarios/demo-full.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const joined = parseEvent({ ...lines[0], seq: 1, ts: 100 });
const make = (type: string, data: unknown, seq = 2) => parseEvent({ agentId: 'sim:hong', seq, ts: seq * 100, type, data });
describe('event contract', () => {
  it('exports a validated event envelope', () => {
    expect(EventEnvelopeSchema.parse({ seq: 1, ts: 100, agentId: 'system' })).toEqual({ seq: 1, ts: 100, agentId: 'system' });
    expect(EventEnvelopeSchema.safeParse({ seq: -1, ts: 100, agentId: 'system' }).success).toBe(false);
  });
  const samples = [...lines, { type: 'agent.left', data: { reason: 'done' }, agentId: 'sim:hong' }, { type: 'split.rejected', data: { collisionId: 'auth-overlap', by: 'Hong' }, agentId: 'system' }];
  for (const schema of TowerEventSchema.options) {
    const type = schema.shape.type.value;
    it(`accepts ${type}`, () => expect(parseEvent({ ...samples.find(e => e.type === type), seq: 1, ts: 1 }).type).toBe(type));
  }
  it('rejects malformed and unknown events with readable fields', () => {
    expect(() => make('file.edit', { path: 'src/a.ts', op: 'oops' })).toThrow('data.op');
    expect(() => make('nope', {})).toThrow('Invalid Tower event');
    expect(() => make('file.read', { path: '../secret' })).toThrow('relative POSIX');
  });
  it('scrubs long prompts, commands and unknown payload fields', () => {
    const prompt = make('intent.declared', { text: 'x'.repeat(600), predictedFiles: [], env: 'secret' });
    expect(prompt.data).toEqual({ text: 'x'.repeat(500), predictedFiles: [] });
    expect(make('command.run', { command: 'x'.repeat(300), kind: 'test' }).data).toEqual({ command: 'x'.repeat(200), kind: 'test' });
  });
});
describe('pure state reducer', () => {
  it('joins, updates status and intent, refreshes lastSeen, leaves', () => {
    const empty = initialState(); const state = reduceState(empty, joined);
    expect(empty.agents).toEqual([]); expect(state.agents[0].joinedAt).toBe(100);
    const working = reduceState(state, make('agent.status', { status: 'working' }));
    expect(working.agents[0].status).toBe('working'); expect(state.agents[0].status).toBe('thinking');
    const intent = reduceState(working, make('intent.declared', { text: 'Rotate tokens', predictedFiles: [] }, 3));
    expect(intent.agents[0].intent).toBe('Rotate tokens'); expect(intent.agents[0].lastSeen).toBe(300);
    expect(reduceState(intent, make('agent.left', {})).agents).toEqual([]);
  });
  it('retains scripted collisions and splits and limits the feed to 50', () => {
    const state = lines.reduce<ReturnType<typeof initialState>>((s, line, i) => reduceState(s, parseEvent({ ...line, seq: i + 1, ts: line.at })), initialState());
    expect(state.claims).toEqual([]); expect(state.recentEvents).toHaveLength(50);
    expect(state.collisions[0].events.map(e => e.type)).toEqual(lines.filter(e => String(e.type).startsWith('collision.') || String(e.type).startsWith('split.') || e.type === 'negotiation.message').map(e => e.type));
  });
});
