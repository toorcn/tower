import { z } from 'zod';
export const AGENT_COLORS = ['#5EEAD4', '#F59E0B', '#A78BFA', '#F472B6', '#60A5FA', '#A3E635'] as const;
export const StatusSchema = z.enum(['thinking', 'working', 'holding', 'idle']);
const path = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !/^[A-Za-z]:/.test(p), 'Expected a relative POSIX path');
export const AgentSchema = z.object({ id: z.string().min(1), pilot: z.string(), tool: z.enum(['claude-code', 'codex', 'sim']), color: z.string(), repoId: z.string(), worktree: z.string(), branch: z.string(), intent: z.string().transform(s => s.slice(0, 500)).optional(), status: StatusSchema, joinedAt: z.number(), lastSeen: z.number() });
export type Agent = z.infer<typeof AgentSchema>;
export const ClaimSchema = z.object({ agentId: z.string(), path, mode: z.enum(['planned', 'editing', 'reading']), ts: z.number(), acquiredAt: z.number().optional() });
export type Claim = z.infer<typeof ClaimSchema>;
const kind = z.enum(['test', 'build', 'git', 'other']);
export const EventEnvelopeSchema = z.object({ seq: z.number().int().nonnegative(), ts: z.number().nonnegative(), agentId: z.string().min(1) });
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
const event = <T extends string, S extends z.ZodTypeAny>(type: T, data: S) => z.object({ ...EventEnvelopeSchema.shape, type: z.literal(type), data });
export const TowerEventSchema = z.discriminatedUnion('type', [
  event('agent.joined', z.object({ agent: AgentSchema })),
  event('agent.left', z.object({ reason: z.string().optional() })),
  event('agent.status', z.object({ status: StatusSchema })),
  event('intent.declared', z.object({ text: z.string().transform(s => s.slice(0, 500)), predictedFiles: z.array(path) })),
  event('file.read', z.object({ path })),
  event('file.search', z.object({ query: z.string(), scope: path.optional() })),
  event('file.edit', z.object({ path, op: z.enum(['create', 'modify', 'delete']) })),
  event('command.run', z.object({ command: z.string().transform(s => s.slice(0, 200)), kind })),
  event('command.done', z.object({ kind, exitCode: z.number().int() })),
  event('hold.applied', z.object({ path, heldBy: z.string(), collisionId: z.string() })),
  event('collision.detected', z.object({ collisionId: z.string(), agentIds: z.tuple([z.string(), z.string()]), files: z.array(path), level: z.enum(['plan', 'edit']), summary: z.string() })),
  event('negotiation.message', z.object({ collisionId: z.string(), from: z.string(), text: z.string() })),
  event('split.proposed', z.object({ collisionId: z.string(), assignments: z.array(z.object({ agentId: z.string(), scope: z.string(), files: z.array(path) })), rationale: z.string(), source: z.enum(['model', 'fallback']) })),
  event('split.accepted', z.object({ collisionId: z.string(), by: z.string() })),
  event('split.rejected', z.object({ collisionId: z.string(), by: z.string() })),
  event('collision.resolved', z.object({ collisionId: z.string() })),
  event('mail.delivered', z.object({ to: z.string(), kind: z.enum(['collision', 'split']) })),
]);
export type TowerEvent = z.infer<typeof TowerEventSchema>;
// Only capture metadata crosses the shim boundary. We discard file contents,
// environment fields and tool output even when a caller bypasses the shim.
const hookCommand = z.string().transform(command => command.startsWith('*** Begin Patch')
  ? command.split('\n').filter(line => /^\*\*\* (Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/.test(line)).join('\n')
  : command.slice(0, 200));
export const HookPayloadSchema = z.object({
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1),
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  tool_use_id: z.string().optional(),
  prompt: z.string().transform(s => s.slice(0, 500)).optional(),
  reason: z.string().max(500).optional(),
  tool_input: z.object({
    file_path: z.string().optional(), path: z.string().optional(),
    pattern: z.string().max(500).optional(), glob: z.string().max(500).optional(),
    command: hookCommand.optional(),
  }).optional(),
  tool_response: z.object({
    type: z.string().optional(), interrupted: z.boolean().optional(),
    is_error: z.boolean().optional(), isError: z.boolean().optional(), error: z.unknown().transform(Boolean).optional(), success: z.boolean().optional(),
    exitCode: z.number().int().optional(), exit_code: z.number().int().optional(),
    metadata: z.object({ exit_code: z.number().int().optional() }).optional(),
  }).optional(),
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;
export const HookRequestSchema = z.object({
  tool: z.enum(['claude-code', 'codex']), pilot: z.string().max(200),
  branch: z.string(), worktree: z.string().min(1), payload: HookPayloadSchema,
});
export function parseEvent(input: unknown): TowerEvent {
  const result = TowerEventSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid Tower event: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
export const StateSchema = z.object({ mode: z.enum(['live', 'scripted']), agents: z.array(AgentSchema), claims: z.array(ClaimSchema), collisions: z.array(z.object({ collisionId: z.string(), events: z.array(TowerEventSchema) })), lastSeq: z.number().int().nonnegative(), recentEvents: z.array(TowerEventSchema) });
export type TowerState = z.infer<typeof StateSchema>;
export const GraphSchema = z.object({ repoId: z.string(), nodes: z.array(z.object({ path, dir: z.string(), loc: z.number(), ext: z.string() })) });
export const StreamMessageSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('snapshot'), state: StateSchema, graph: GraphSchema }), z.object({ kind: z.literal('event'), event: TowerEventSchema })]);
export function initialState(mode: TowerState['mode'] = 'live'): TowerState { return { mode, agents: [], claims: [], collisions: [], lastSeq: 0, recentEvents: [] }; }
// Shared with the browser so streaming and snapshots use identical roster updates.
export function reduceState(state: TowerState, event: TowerEvent): TowerState {
  let agents = state.agents.map(a => a.id === event.agentId ? { ...a, lastSeen: event.ts } : a);
  if (event.type === 'agent.joined') agents = [...agents.filter(a => a.id !== event.data.agent.id), { ...event.data.agent, joinedAt: event.ts, lastSeen: event.ts }];
  if (event.type === 'agent.left') agents = agents.filter(a => a.id !== event.agentId);
  if (event.type === 'agent.status') { const status = event.data.status; agents = agents.map(a => a.id === event.agentId ? { ...a, status } : a); }
  if (event.type === 'intent.declared') { const intent = event.data.text; agents = agents.map(a => a.id === event.agentId ? { ...a, intent } : a); }
  let collisions = state.collisions;
  if (event.type.startsWith('collision.') || event.type.startsWith('split.') || event.type === 'negotiation.message') {
    const collisionId = (event.data as { collisionId: string }).collisionId;
    const previous = collisions.find(c => c.collisionId === collisionId);
    collisions = [...collisions.filter(c => c.collisionId !== collisionId), { collisionId, events: [...(previous?.events ?? []), event] }];
  }
  return { ...state, agents, collisions, lastSeq: event.seq, recentEvents: [...state.recentEvents, event].slice(-50) };
}
