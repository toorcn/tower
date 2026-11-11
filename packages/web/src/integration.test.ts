import { expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../server/src/index';
import { parseEvent } from '@tower/shared';
import { derive, emptyPanel } from './derive';

it('turns live phase-four collisions into UI state and rebuilds panels from replayed events', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'tower-ui-integration-'));
  const { app } = await createServer({ logDir });
  try {
    const events = readFileSync('scenarios/demo-agents.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const { at, ...event } of events.filter(e => e.at <= 30000)) {
      const response = await app.inject({ method: 'POST', url: '/v1/events', payload: event });
      expect(response.statusCode).toBe(200);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const state = (await app.inject('/v1/state')).json();
    expect(state.mode).toBe('live');
    expect(state.collisions.length).toBeGreaterThan(0);
    let panel = emptyPanel();
    const { readdirSync } = await import('node:fs');
    const stored = readdirSync(logDir).flatMap(f => readFileSync(join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    for (const event of stored) panel = derive(panel, parseEvent(event));
    expect(panel.collisions.length).toBeGreaterThan(0);
    expect(panel.collisions[0].agentIds).toEqual(expect.arrayContaining(['sim:hong', 'sim:sarah']));
    expect(panel.collisions[0].agentIds).not.toContain('sim:wei');
    const collision = stored.find(e => e.type === 'collision.detected');
    panel = derive(panel, { ...collision, seq: 999, type: 'negotiation.message', data: {collisionId: collision.data.collisionId, from:'sim:hong', text:'Keep this message'} });
    panel = derive(panel, { ...collision, seq:1000 });
    expect(panel.collisions[0].messages).toHaveLength(1);
  } finally { await app.close(); rmSync(logDir, { recursive:true, force:true }); }
}, 30000);
