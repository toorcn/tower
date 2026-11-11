import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvent, type TowerEvent } from '../../shared/src/index.js';
export type ScenarioLine = { at: number } & Pick<TowerEvent, 'agentId' | 'type' | 'data'>;
export function timingDelays(lines: { at: number }[], speed: number): number[] {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Speed must be positive');
  let previous = 0;
  return lines.map(line => {
    if (!Number.isFinite(line.at) || line.at < previous) throw new Error('Scenario times must be nonnegative and ordered');
    const delay = (line.at - previous) / speed; previous = line.at; return delay;
  });
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function simulate(args: string[]) {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('Usage: pnpm sim <file> [--speed 2] [--loop] [--no-reset]');
  const speedIndex = args.indexOf('--speed');
  const speed = speedIndex < 0 ? 1 : Number(args[speedIndex + 1]);
  const lines: ScenarioLine[] = readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((line, i) => {
    try { const raw = JSON.parse(line); const event = parseEvent({ ...raw, seq: 0, ts: 0 }); return { at: raw.at, agentId: event.agentId, type: event.type, data: event.data }; }
    catch (error) { throw new Error(`Line ${i + 1}: ${(error as Error).message}`); }
  });
  timingDelays(lines, speed);
  const url = process.env.TOWER_URL ?? 'http://127.0.0.1:4317';
  const post = async (route: string, body: unknown) => {
    for (;;) {
      try {
        const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
        if (response.status >= 400 && response.status < 500) throw new Error(`Rejected: ${await response.text()}`);
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return;
      } catch (error) {
        if ((error as Error).message.startsWith('Rejected:')) throw error;
        console.warn('Tower unavailable. Retrying in one second.'); await sleep(1000);
      }
    }
  };
  do {
    if (!args.includes('--no-reset')) await post('/v1/admin/reset', { mode: lines.some(line => line.agentId === 'system') ? 'scripted' : 'live' });
    const start = performance.now();
    for (const line of lines) { await sleep(Math.max(0, line.at / speed - (performance.now() - start))); const { at, ...event } = line; await post('/v1/events', event); }
    console.log(`Played ${lines.length} events from ${file}`);
  } while (args.includes('--loop'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) simulate(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
