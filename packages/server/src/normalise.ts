import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HookPayload as SharedHookPayload, TowerEvent } from '../../shared/src/index.js';

/** We only inspect metadata. We never return file contents or tool output. */
export type HookPayload = Omit<SharedHookPayload, 'tool_input' | 'tool_response'> & {
  // We also accept scrubbed raw fixtures. Live requests use the shared schema.
  tool_input?: unknown;
  tool_response?: unknown;
};
export interface NormaliseContext { worktree: string; knownPaths: readonly string[] }
type WithoutEnvelope<T> = T extends TowerEvent ? Omit<T, 'agentId' | 'seq' | 'ts'> : never;
export type NormalisedEvent = WithoutEnvelope<TowerEvent>;
export type FileEdit = { path: string; op: 'create' | 'modify' | 'delete' };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

export function toRelativePath(path: string, worktree: string, cwd = worktree): string | undefined {
  if (!path || path.includes('\0') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) return undefined;
  const root = resolve(worktree);
  const absolute = resolve(cwd, path.replaceAll('\\', '/'));
  const result = relative(root, absolute).split(sep).join('/');
  if (!result || result === '..' || result.startsWith('../') || isAbsolute(result)) return undefined;
  return result;
}

/** apply_patch has a line-based envelope. We need only its file headers. */
export function parsePatch(patch: string, worktree: string, cwd = worktree): FileEdit[] {
  const lines = patch.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return [];
  const edits: FileEdit[] = [];
  let pending: { path?: string; op: FileEdit['op'] } | undefined;
  const flush = () => { if (pending?.path) edits.push({ path: pending.path, op: pending.op }); pending = undefined; };
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!header) continue;
    const path = toRelativePath(header[2], worktree, cwd);
    if (header[1] === 'Move to') {
      if (pending?.op === 'modify') {
        if (pending.path) edits.push({ path: pending.path, op: 'delete' });
        if (path) edits.push({ path, op: 'create' });
      }
      pending = undefined;
    } else {
      flush();
      pending = { path, op: header[1] === 'Add File' ? 'create' : header[1] === 'Delete File' ? 'delete' : 'modify' };
    }
  }
  flush();
  return [...new Map(edits.map(edit => [edit.path, edit])).values()];
}

/** Split shell words without evaluation or command substitution. */
export function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  const flush = () => { if (word) tokens.push(word); word = ''; };
  for (const ch of command) {
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (';&|()<>\n'.includes(ch)) { flush(); tokens.push(ch); continue; }
    if (/\s/.test(ch)) flush(); else word += ch;
  }
  flush();
  return tokens;
}

export function commandKind(command: string): 'test' | 'build' | 'git' | 'other' {
  if (/(?:^|[\s/;&|])(?:vitest|jest|mocha|ava|pytest|tap)(?:$|[\s;&|])|\b(?:npm|pnpm|yarn|bun|cargo|go)\s+(?:run\s+)?test\b|\bnode\s+--test\b/.test(command)) return 'test';
  if (/\b(?:build|typecheck|tsc)\b/.test(command)) return 'build';
  if (/(?:^|[\s/;&|])git(?:$|\s)/.test(command)) return 'git';
  return 'other';
}

function shellEvents(command: string, payload: HookPayload, context: NormaliseContext): NormalisedEvent[] {
  const events: NormalisedEvent[] = [{ type: 'command.run', data: { command: command.slice(0, 200), kind: commandKind(command) } }];
  const tokens = shellTokens(command);
  const known = new Set(context.knownPaths);
  const seen = new Set<string>();
  let cwd = payload.cwd;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'cd' && tokens[i + 1] && !tokens[i + 1].startsWith('-')) { cwd = resolve(cwd, tokens[i + 1]); i++; continue; }
    const path = toRelativePath(tokens[i], context.worktree, cwd);
    if (path && known.has(path) && !seen.has(path)) { seen.add(path); events.push({ type: 'file.read', data: { path } }); }
    if (tokens[i] === 'rg' || tokens[i] === 'grep') {
      const args: string[] = [];
      let explicitPattern: string | undefined;
      for (let j = i + 1; j < tokens.length && !/^[;&|()<>\n]$/.test(tokens[j]); j++) {
        if (['-g', '--glob', '-t', '--type', '-f', '--file', '-A', '-B', '-C', '--max-count'].includes(tokens[j])) { j++; continue; }
        if (tokens[j] === '-e' || tokens[j] === '--regexp') { explicitPattern = tokens[++j]; continue; }
        if (!tokens[j].startsWith('-')) args.push(tokens[j]);
      }
      const query = explicitPattern ?? args.shift();
      const scope = args[0] ? toRelativePath(args[0], context.worktree, cwd) : undefined;
      if (query) events.push({ type: 'file.search', data: { query: query.slice(0, 500), ...(scope ? { scope } : {}) } });
    }
  }
  return events;
}

function lifecycle(payload: HookPayload): NormalisedEvent[] | undefined {
  switch (payload.hook_event_name) {
    case 'SessionStart': return [];
    case 'UserPromptSubmit': return typeof payload.prompt === 'string' ? [
      { type: 'intent.declared', data: { text: payload.prompt.slice(0, 500), predictedFiles: [] } },
      { type: 'agent.status', data: { status: 'thinking' } },
    ] : [];
    case 'Stop': return [{ type: 'agent.status', data: { status: 'idle' } }];
    case 'SessionEnd': return [{ type: 'agent.left', data: typeof payload.reason === 'string' ? { reason: payload.reason.slice(0, 200) } : {} }];
    default: return undefined;
  }
}

/** The shim may reduce a tool response to these metadata fields. */
function exitCode(response: unknown, claude = false, patch = false): number | undefined {
  const value = record(response);
  if (value.interrupted === true || value.is_error === true || value.isError === true || value.success === false || value.error) return undefined;
  for (const code of [value.exitCode, value.exit_code, record(value.metadata).exit_code]) if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof response === 'string') {
    // Bash's string is stdout, so even text resembling metadata is untrusted.
    // apply_patch has a distinct, observed completion envelope.
    const match = patch ? /^Exit code:\s*(-?\d+)\r?\nWall time:/.exec(response) : undefined;
    if (match) return Number(match[1]);
    return undefined;
  }
  return claude && response && typeof response === 'object' ? 0 : value.success === true ? 0 : undefined;
}

export function normaliseClaudeCode(payload: HookPayload, context: NormaliseContext): NormalisedEvent[] {
  const common = lifecycle(payload);
  if (common) return common;
  const input = record(payload.tool_input);
  const path = toRelativePath(string(input.file_path), context.worktree, payload.cwd);
  if (payload.hook_event_name === 'PreToolUse') {
    if (payload.tool_name === 'Read') return path ? [{ type: 'file.read', data: { path } }] : [];
    if (payload.tool_name === 'Grep' || payload.tool_name === 'Glob') {
      const query = string(input.pattern);
      const rawScope = string(input.path);
      const scope = toRelativePath(rawScope, context.worktree, payload.cwd);
      if (rawScope && !scope && resolve(payload.cwd, rawScope) !== resolve(context.worktree)) return [];
      return query ? [{ type: 'file.search', data: { query: query.slice(0, 500), ...(scope ? { scope } : {}) } }] : [];
    }
    if (['Edit', 'Write', 'MultiEdit'].includes(payload.tool_name ?? '')) return path ? [{ type: 'agent.status', data: { status: 'working' } }] : [];
    if (payload.tool_name === 'Bash' && typeof input.command === 'string') return shellEvents(input.command, payload, context);
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const code = exitCode(payload.tool_response, true);
    if (payload.tool_name === 'Bash' && code !== undefined) return [{ type: 'command.done', data: { kind: commandKind(string(input.command)), exitCode: code } }];
    if (path && ['Edit', 'Write', 'MultiEdit'].includes(payload.tool_name ?? '') && code === 0) return [{ type: 'file.edit', data: { path, op: payload.tool_name === 'Write' && record(payload.tool_response).type === 'create' ? 'create' : 'modify' } }];
  }
  return [];
}

export function normaliseCodex(payload: HookPayload, context: NormaliseContext): NormalisedEvent[] {
  const common = lifecycle(payload);
  if (common) return common;
  const input = record(payload.tool_input);
  const command = string(input.command);
  if (payload.hook_event_name === 'PreToolUse') {
    if (payload.tool_name === 'Bash' && command) return shellEvents(command, payload, context);
    if (payload.tool_name === 'apply_patch' && parsePatch(command, context.worktree, payload.cwd).length) return [{ type: 'agent.status', data: { status: 'working' } }];
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const code = exitCode(payload.tool_response, false, payload.tool_name === 'apply_patch');
    if (payload.tool_name === 'Bash' && code !== undefined) return [{ type: 'command.done', data: { kind: commandKind(command), exitCode: code } }];
    if (payload.tool_name === 'apply_patch' && code === 0) return parsePatch(command, context.worktree, payload.cwd).map(data => ({ type: 'file.edit', data }));
  }
  return [];
}
