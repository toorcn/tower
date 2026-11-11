import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { mkdirSync, openSync, appendFileSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { initialState, reduceState, parseEvent, AGENT_COLORS, HookRequestSchema, type TowerEvent } from '../../shared/src/index.js';
import { claim, expire, priority, replacePlanned, updateClaims } from './claims.js';
import { fallbackSplit, fallbackLines, modelNegotiation, anthropicCall, type ModelCall } from './negotiation.js';
import { collisions } from './collision.js';
import { predictTask } from './prediction.js';
import { hookResponse, type Mail } from './hook-response.js';
import { editPaths, heldFiles } from './holds.js';
import { normaliseClaudeCode, normaliseCodex } from './normalise.js';
import { scanGraph, graphNode, commonGitDirectory, type FileGraph } from './graph.js';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
  const parent = dirname(root);
  if (parent === root) throw new Error('Cannot find Tower workspace');
  root = parent;
}
export async function createServer(options: { host?: string; logDir?: string; repo?: string; modelCall?: ModelCall } = {}) {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('Tower only binds 127.0.0.1');
  const app = Fastify({ logger: true });
  await app.register(websocket);
  let state = initialState();
  let agentColors = new Map<string, string>();
  const clients = new Set<WebSocket>();
  const logDir = options.logDir ?? resolve(root, '.tower/logs');
  mkdirSync(logDir, { recursive: true });
  let logFile = '';
  const newLog = () => { logFile = resolve(logDir, `${Date.now()}-${crypto.randomUUID()}.jsonl`); return openSync(logFile, 'ax'); };
  let log = newLog();
  let logPathEvents: TowerEvent[] = [];
  const repoRoot = options.repo ?? process.env.TOWER_REPO;
  let scanned: FileGraph | undefined = repoRoot ? scanGraph(repoRoot) : undefined;
  const repoIds = new Map<string, string>();
  const commonRepoIds = new Map<string, string>();
  if (repoRoot && scanned) commonRepoIds.set(commonGitDirectory(repoRoot), scanned.repoId);
  const reads = new Map<string, number>();
  const graph = (repoId = scanned?.repoId ?? state.agents[0]?.repoId ?? '') => {
    if (scanned) return { repoId, nodes: repoId === scanned.repoId ? scanned.nodes : [] };
    const paths = new Set<string>();
    const agentRepos = new Map(state.agents.map(a => [a.id, a.repoId]));
    // Joined events retain repo identity even after an agent leaves.
    for (const e of logPathEvents) if (e.type === 'agent.joined') agentRepos.set(e.data.agent.id, e.data.agent.repoId);
    for (const e of logPathEvents) {
      if (e.agentId !== 'system' && repoId && agentRepos.get(e.agentId) !== repoId) continue;
      if ('path' in e.data) paths.add(e.data.path);
      if ('predictedFiles' in e.data) e.data.predictedFiles.forEach(p => paths.add(p));
      if ('files' in e.data) e.data.files.forEach(p => paths.add(p));
      if ('assignments' in e.data) e.data.assignments.forEach(a => a.files.forEach(p => paths.add(p)));
    }
    return { repoId, nodes: [...paths].sort().map(path => ({ path, dir: dirname(path), loc: 0, ext: extname(path).slice(1) })) };
  };
  const snapshot = () => ({ kind: 'snapshot', state, graph: graph() });
  const broadcast = (message: unknown) => { const json = JSON.stringify(message); for (const client of clients) if (client.readyState === 1) client.send(json); };
  const mailbox = new Map<string, Mail[]>();
  const holds = new Map<string, number>();
  let generation = 0;
  const predictionVersions = new Map<string, number>();
  const queueMail = (agentId: string, kind: Mail['kind'], text: string) => mailbox.set(agentId, [...(mailbox.get(agentId) ?? []), { kind, text }]);
  const running = new Set<string>();
  const retries = new Map<string, number>();
  const proposals = new Map<string, number>();
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const accept = (id: string) => {
    const collision = state.collisions.find(c => c.collisionId === id);
    if (!collision) return false;
    if (collision.events.some(e => e.type === 'collision.resolved')) return true;
    const proposal = collision.events.filter(e => e.type === 'split.proposed').at(-1);
    if (proposal?.type !== 'split.proposed' || proposals.get(id) !== proposal.seq) return false;
    publish([{ agentId: 'system', type: 'split.accepted', data: { collisionId: id, by: 'team' } }]);
    for (const own of proposal.data.assignments) {
      const other = proposal.data.assignments.find(a => a.agentId !== own.agentId)!;
      state.claims = state.claims.filter(c => !other.files.includes(c.path) || c.agentId !== own.agentId);
      queueMail(own.agentId, 'split', `Tower: split agreed with ${state.agents.find(a => a.id === other.agentId)?.pilot}'s agent. You own: ${own.files.join(', ') || 'no contested files'}. Your part: ${own.scope}. Their agent owns: ${other.files.join(', ') || 'no contested files'}, for: ${other.scope}. Do not edit their files. If you need a change there, describe it in your final summary instead.`);
    }
    publish([{ agentId: 'system', type: 'collision.resolved', data: { collisionId: id } }]);
    return true;
  };
  const negotiate = async (id: string) => {
    if (running.has(id)) return;
    running.add(id);
    const version = generation;
    const valid = () => generation === version && state.mode === 'live';
    try {
      await wait(1500);
      if (!valid()) return;
      const collision = state.collisions.find(c => c.collisionId === id)!;
      const detected = collision.events.filter(e => e.type === 'collision.detected').at(-1);
      if (detected?.type !== 'collision.detected') return;
      const { agentIds, files } = detected.data;
      let split = fallbackSplit(state, agentIds, files);
      const first = agentIds.find(agentId => heldFiles(state, agentId, files).length) ?? agentIds[1];
      let lines = fallbackLines(state, split, first);
      let source: 'model' | 'fallback' = 'fallback';
      if (options.modelCall || process.env.ANTHROPIC_API_KEY) {
        try {
          const result = await modelNegotiation(state, agentIds, files, first, (retries.get(id) ?? 0) > 0, options.modelCall ?? anthropicCall(process.env.ANTHROPIC_API_KEY!, process.env.TOWER_MODEL));
          split = result.split; lines = result.lines; source = 'model';
        } catch { /* The deterministic exchange remains available with no network. */ }
      }
      for (let i = 0; i < lines.length; i++) {
        if (i) await wait(1800);
        if (!valid()) return;
        publish([{ agentId: 'system', type: 'negotiation.message', data: { collisionId: id, ...lines[i] } }]);
      }
      const latest = state.collisions.find(c => c.collisionId === id)?.events.filter(e => e.type === 'collision.detected').at(-1);
      if (latest?.type === 'collision.detected' && JSON.stringify(latest.data.files) !== JSON.stringify(files)) {
        running.delete(id); void negotiate(id); return;
      }
      publish([{ agentId: 'system', type: 'split.proposed', data: { collisionId: id, ...split, source } }]);
      proposals.set(id, state.lastSeq);
      const seconds = Number(process.env.TOWER_AUTO_ACCEPT);
      if (Number.isFinite(seconds) && seconds >= 0 && process.env.TOWER_AUTO_ACCEPT !== undefined) {
        const seq = state.lastSeq;
        setTimeout(() => { if (valid() && proposals.get(id) === seq) accept(id); }, seconds * 1000).unref();
      }
    } finally { running.delete(id); }
  };
  const detect = () => {
    if (state.mode !== 'live') return;
    for (const pair of collisions(state)) {
      const previous = state.collisions.find(c => !c.events.some(e => e.type === 'collision.resolved') && c.events.some(e => e.type === 'collision.detected' && JSON.stringify(e.data.agentIds) === JSON.stringify(pair.agentIds)));
      const last = previous?.events.filter(e => e.type === 'collision.detected').at(-1);
      if (last?.type === 'collision.detected') pair.files = [...new Set([...last.data.files, ...pair.files])].sort();
      if (last?.type === 'collision.detected' && JSON.stringify(last.data.files) === JSON.stringify(pair.files) && last.data.level === pair.level) continue;
      const collisionId = previous?.collisionId ?? crypto.randomUUID();
      const summary = `${pair.agentIds.map(id => state.agents.find(a => a.id === id)?.pilot).join(' and ')} overlap on ${pair.files.length} files.`;
      publish([{ agentId: 'system', type: 'collision.detected', data: { ...pair, collisionId, summary } }]);
      if (!previous) void negotiate(collisionId);
      if (last?.type === 'collision.detected' && JSON.stringify(last.data.files) === JSON.stringify(pair.files)) continue;
      for (const id of pair.agentIds) {
        const other = state.agents.find(a => a.id === pair.agentIds.find(x => x !== id));
        const waiting = pair.files.some(path => { const cs = state.claims.filter(c => c.path === path && pair.agentIds.includes(c.agentId)); return cs.length > 1 && priority(cs[0], cs[1]).agentId !== id; });
        queueMail(id, 'collision', `Tower: ${other?.pilot}'s agent (${other?.intent ?? 'working'}) overlaps on ${pair.files.join(', ')}. ${waiting ? (process.env.TOWER_ENFORCE === 'warn' || process.env.TOWER_ENFORCE === 'off' ? 'Warning: your tasks overlap. Edits are allowed in this enforcement mode.' : 'You are on hold for files owned by the other agent until a split is agreed. Work on other files.') : 'Someone is waiting. Keep going for now.'}`);
      }
    }
  };
  const publish = (bodies: unknown[], completedPrediction = false) => {
    if (!bodies.length) return { accepted: 0, lastSeq: state.lastSeq };
    let events: TowerEvent[];
    const pendingColors = new Map(agentColors);
    events = bodies.map((body, i) => {
        const input = body && typeof body === 'object' ? body : {};
        const parsed = parseEvent({ ...input, seq: state.lastSeq + i + 1, ts: Date.now() });
        if (parsed.type === 'agent.joined') {
          if (parsed.agentId !== parsed.data.agent.id) throw new Error('agentId must match the joined agent id');
          if (!pendingColors.has(parsed.agentId)) pendingColors.set(parsed.agentId, AGENT_COLORS[pendingColors.size % AGENT_COLORS.length]);
          parsed.data.agent.color = pendingColors.get(parsed.agentId)!;
        }
        return parsed;
    });
    // Persist the validated batch before publishing or mutating state.
    appendFileSync(log, events.map(e => JSON.stringify(e) + '\n').join(''));
    fsyncSync(log);
    agentColors = pendingColors;
    for (const event of events) {
      state = reduceState(state, event); logPathEvents.push(event);
      if (scanned && repoRoot && event.type === 'file.edit' && event.data.op === 'create' && !scanned.nodes.some(n => n.path === event.data.path)) {
        const agent = state.agents.find(a => a.id === event.agentId);
        if (agent?.repoId === scanned.repoId) {
          const node = graphNode(agent.worktree, event.data.path);
          if (node) scanned.nodes.push(node);
        }
      }
      broadcast({ kind: 'event', event });
    }
    if (state.mode === 'live') {
      for (const event of events) {
        state.claims = updateClaims(state.claims, event);
        // A resumed session keeps its identity and must receive pending split mail.
        if (event.type === 'agent.left') predictionVersions.delete(event.agentId);
        if (event.type === 'intent.declared' && !completedPrediction) predictionVersions.set(event.agentId, event.seq);
        if (event.type === 'intent.declared' && !completedPrediction && !event.data.predictedFiles.length && event.data.text.trim().split(/\s+/).length >= 4) {
          const version = generation;
          const paths = graph(state.agents.find(a => a.id === event.agentId)?.repoId).nodes.map(n => n.path);
          setImmediate(async () => {
            if (generation !== version || predictionVersions.get(event.agentId) !== event.seq || state.mode !== 'live' || !state.agents.some(a => a.id === event.agentId && a.intent === event.data.text)) return;
            const result = await predictTask(event.data.text, paths, { key: process.env.ANTHROPIC_API_KEY, model: process.env.TOWER_MODEL });
            if (generation !== version || predictionVersions.get(event.agentId) !== event.seq || state.mode !== 'live' || !state.agents.some(a => a.id === event.agentId && a.intent === event.data.text)) return;
            state.claims = replacePlanned(state.claims, event.agentId, [], event.ts);
            publish([{ agentId: event.agentId, type: 'intent.declared', data: { text: result.summary, predictedFiles: result.files } }], true);
          });
        }
      }
      if (events.some(e => ['file.read', 'file.edit', 'intent.declared', 'agent.left'].includes(e.type))) detect();
    }
    return { accepted: events.length, lastSeq: state.lastSeq };
  };
  app.post('/v1/events', async (request, reply) => {
    const bodies = Array.isArray(request.body) ? request.body : [request.body];
    if (state.mode === 'live' && bodies.some(body => body?.agentId === 'system')) return reply.code(400).send({ error: 'System events require scripted mode' });
    try { return publish(bodies); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/v1/collisions/:id/accept', async (request, reply) => accept(request.params.id) ? { ok: true } : reply.code(409).send({ error: 'No current proposal' }));
  app.post<{ Params: { id: string } }>('/v1/collisions/:id/reject', async (request, reply) => {
    const id = request.params.id;
    const c = state.collisions.find(c => c.collisionId === id);
    if (!c) return reply.code(404).send({ error: 'Unknown collision' });
    if (c.events.some(e => e.type === 'collision.resolved')) return { ok: true };
    if (!proposals.has(id)) return { ok: true };
    proposals.delete(id);
    publish([{ agentId: 'system', type: 'split.rejected', data: { collisionId: id, by: 'team' } }]);
    const count = (retries.get(id) ?? 0) + 1; retries.set(id, count);
    if (count === 1) void negotiate(id);
    return { ok: true };
  });
  app.get('/v1/state', async () => state);
  app.get<{ Querystring: { repoId?: string } }>('/v1/graph', async request => graph(request.query.repoId));
  app.post('/v1/hook', async request => {
    const parsed = HookRequestSchema.safeParse(request.body);
    if (!parsed.success || state.mode !== 'live') return {};
    const { tool, pilot, branch, worktree, payload } = parsed.data;
    if (!isAbsolute(worktree) || !isAbsolute(payload.cwd)) return {};
    if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'].includes(payload.hook_event_name)) return {};
    const agentId = `${tool}:${payload.session_id}`;
    try {
      let repoId = repoIds.get(worktree);
      if (!repoId) {
        const common = commonGitDirectory(worktree);
        repoId = commonRepoIds.get(common) ?? (basename(common) === '.git' ? basename(dirname(common)) : basename(worktree));
        repoIds.set(worktree, repoId);
        commonRepoIds.set(common, repoId);
      }
      const context = { worktree, knownPaths: graph(repoId).nodes.map(n => n.path) };
      const normalise = tool === 'claude-code' ? normaliseClaudeCode : normaliseCodex;
      const now = Date.now();
      const events: unknown[] = [];
      if (!state.agents.some(a => a.id === agentId)) events.push({ agentId, type: 'agent.joined', data: { agent: {
        id: agentId, tool, pilot, branch, worktree, repoId, color: '', status: 'thinking', joinedAt: now, lastSeen: now,
      } } });
      const pendingReads = new Map(reads);
      for (const event of normalise(payload, context)) {
        if (event.type === 'file.read') {
          const key = `${agentId}\0${event.data.path}`;
          if (now - (pendingReads.get(key) ?? -Infinity) < 2000) continue;
          pendingReads.set(key, now);
        }
        events.push({ ...event, agentId });
      }
      publish(events);
      let reason = '';
      const enforce = process.env.TOWER_ENFORCE ?? 'hold';
      if (payload.hook_event_name === 'PreToolUse') {
        const paths = editPaths(tool, payload, worktree);
        state.claims = expire(state.claims, now);
        for (const path of paths) state.claims = claim(state.claims, { agentId, path, mode: 'editing', ts: now });
        if (paths.length) detect();
        const denied = enforce === 'off' ? [] : heldFiles(state, agentId, paths);
        reason = denied.map(hold => hold.reason).join('\n');
        if (denied.length && enforce === 'hold') {
          const events: unknown[] = [];
          for (const hold of denied) {
            const key = `${agentId}:${hold.path}`;
            if (now - (holds.get(key) ?? -Infinity) >= 10000) {
              holds.set(key, now);
              events.push({ agentId, type: 'hold.applied', data: { path: hold.path, heldBy: hold.heldBy, collisionId: hold.collisionId } });
            }
          }
          events.push({ agentId, type: 'agent.status', data: { status: 'holding' } });
          publish(events);
        }
      }
      const result = hookResponse(payload.hook_event_name, mailbox.get(agentId) ?? [], reason, enforce, payload.stop_hook_active);
      if (result.delivered.length) {
        mailbox.delete(agentId);
        publish(result.delivered.map(m => ({ agentId: 'system', type: 'mail.delivered', data: { to: agentId, kind: m.kind } })));
      }
      reads.clear();
      for (const [key, ts] of pendingReads) {
        const ended = payload.hook_event_name === 'SessionEnd' && key.startsWith(`${agentId}\0`);
        if (now - ts < 2000 && !ended) reads.set(key, ts);
      }
      return result.response;
    } catch { /* The shim and capture route fail open without raw error output. */ }
    return {};
  });
  app.post('/v1/admin/reset', async (request, reply) => {
    const body = request.body as { mode?: string } | undefined;
    if (body?.mode && !['live', 'scripted'].includes(body.mode)) return reply.code(400).send({ error: 'Expected live or scripted mode' });
    const nextGraph = repoRoot ? scanGraph(repoRoot) : undefined;
    generation++; proposals.clear(); retries.clear(); running.clear(); mailbox.clear(); holds.clear(); predictionVersions.clear();
    closeSync(log); log = newLog(); state = initialState(body?.mode === 'scripted' ? 'scripted' : 'live'); agentColors.clear(); logPathEvents = []; reads.clear(); repoIds.clear(); scanned = nextGraph; broadcast(snapshot()); return state;
  });
  app.get<{ Querystring: { since?: string } }>('/v1/stream', { websocket: true }, (socket, request) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    socket.send(JSON.stringify(snapshot()));
    const since = Number(request.query.since);
    if (Number.isSafeInteger(since) && since >= 0) {
      // Replay the current run from its durable JSONL log. Clients deduplicate by seq.
      const saved = readFileSync(logFile, 'utf8');
      for (const line of saved.trim().split('\n').filter(Boolean)) { const event = parseEvent(JSON.parse(line)); if (event.seq > since) socket.send(JSON.stringify({ kind: 'event', event })); }
    }
  });
  const webRoot = resolve(root, 'packages/web/dist');
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  const expiry = setInterval(() => { if (state.mode === 'live') { state.claims = expire(state.claims, Date.now()); detect(); } }, 5000);
  expiry.unref();
  app.addHook('onClose', async () => { clearInterval(expiry); generation++; for (const client of clients) client.terminate(); closeSync(log); });
  return { app, host };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, host } = await createServer({ host: process.env.HOST });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close(); });
  await app.listen({ port: 4317, host });
}
