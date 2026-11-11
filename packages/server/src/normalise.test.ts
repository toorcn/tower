import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../../shared/src/index.js';
import { commandKind, normaliseClaudeCode, normaliseCodex, parsePatch, shellTokens, toRelativePath, type HookPayload } from './normalise.js';

const fixtures = (tool: string): HookPayload[] => {
  const dir = fileURLToPath(new URL(`../../../fixtures/raw/${tool}/`, import.meta.url));
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as HookPayload);
};
const claude = fixtures('claude-code');
const codex = fixtures('codex');
const fixture = (tool: HookPayload[], event: string, name?: string, command?: string) => {
  const found = tool.find(item => item.hook_event_name === event && (!name || item.tool_name === name) && (!command || (item.tool_input as { command?: string })?.command?.includes(command)));
  if (!found) throw new Error(`Missing real fixture: ${event} ${name} ${command}`);
  return found;
};
const context = { worktree: '/repo', knownPaths: ['src/auth/session.ts', 'src/auth/tokens.ts'] };

describe('real lifecycle fixtures', () => {
  for (const [name, inputs, normalise] of [['Claude Code', claude, normaliseClaudeCode], ['Codex', codex, normaliseCodex]] as const) {
    it(`${name} handles prompt, stop and end without leaking hook metadata`, () => {
      const prompt = fixture(inputs, 'UserPromptSubmit');
      expect(normalise(prompt, context)).toEqual([
        { type: 'intent.declared', data: { text: prompt.prompt, predictedFiles: [] } },
        { type: 'agent.status', data: { status: 'thinking' } },
      ]);
      expect(normalise({ ...prompt, prompt: 'x'.repeat(600) }, context)[0].data).toMatchObject({ text: 'x'.repeat(500) });
      expect(normalise(fixture(inputs, 'SessionStart'), context)).toEqual([]);
      expect(normalise(fixture(inputs, 'Stop'), context)).toEqual([{ type: 'agent.status', data: { status: 'idle' } }]);
      expect(normalise(fixture(inputs, 'SessionEnd'), context)).toEqual([{ type: 'agent.left', data: { reason: 'other' } }]);
    });
    it(`${name} produces only contract-valid events for every fixture`, () => {
      for (const input of inputs) for (const event of normalise(input, context)) {
        expect(() => parseEvent({ ...event, agentId: `${name}:fixture`, seq: 1, ts: 1 })).not.toThrow();
        expect(JSON.stringify(event)).not.toContain('tool_response');
      }
    });
  }
});

describe('Claude Code real tool fixtures', () => {
  it('maps Read and Grep to paths relative to the worktree', () => {
    expect(normaliseClaudeCode(fixture(claude, 'PreToolUse', 'Read'), context)).toEqual([{ type: 'file.read', data: { path: 'src/auth/session.ts' } }]);
    expect(normaliseClaudeCode(fixture(claude, 'PreToolUse', 'Grep'), context)).toEqual([{ type: 'file.search', data: { query: 'sessionExpiry', scope: 'src/auth' } }]);
    expect(normaliseClaudeCode({ ...fixture(claude, 'PreToolUse', 'Grep'), tool_input: { pattern: 'sessionExpiry', path: '/outside' } }, context)).toEqual([]);
  });
  it('marks edits working before and emits successful Edit and Write after', () => {
    expect(normaliseClaudeCode(fixture(claude, 'PreToolUse', 'Edit'), context)).toEqual([{ type: 'agent.status', data: { status: 'working' } }]);
    expect(normaliseClaudeCode(fixture(claude, 'PostToolUse', 'Edit'), context)).toEqual([{ type: 'file.edit', data: { path: 'src/auth/session.ts', op: 'modify' } }]);
    expect(normaliseClaudeCode(fixture(claude, 'PostToolUse', 'Write'), context)).toEqual([{ type: 'file.edit', data: { path: 'src/auth/capture-note.ts', op: 'create' } }]);
  });
  it('does not report failed edits or writes outside the worktree', () => {
    const edit = fixture(claude, 'PostToolUse', 'Edit');
    expect(normaliseClaudeCode({ ...edit, tool_response: { isError: true } }, context)).toEqual([]);
    expect(normaliseClaudeCode({ ...edit, tool_input: { file_path: '/elsewhere/session.ts' } }, context)).toEqual([]);
    expect(normaliseClaudeCode({ ...edit, tool_response: undefined }, context)).toEqual([]);
  });
  it('maps Bash completion without copying stdout or stderr', () => {
    expect(normaliseClaudeCode(fixture(claude, 'PostToolUse', 'Bash'), context)).toEqual([{ type: 'command.done', data: { kind: 'other', exitCode: 0 } }]);
    expect(normaliseClaudeCode({ ...fixture(claude, 'PostToolUse', 'Bash'), tool_response: { interrupted: true } }, context)).toEqual([]);
  });
});

describe('Codex real tool fixtures', () => {
  it('recognises Bash as shell and finds both known file tokens', () => {
    const input = fixture(codex, 'PreToolUse', 'Bash', 'cat src/auth/session.ts');
    expect(normaliseCodex(input, context)).toEqual([
      { type: 'command.run', data: { command: 'cat src/auth/session.ts src/auth/tokens.ts', kind: 'other' } },
      { type: 'file.read', data: { path: 'src/auth/session.ts' } },
      { type: 'file.read', data: { path: 'src/auth/tokens.ts' } },
    ]);
  });
  it('recognises shell search without inventing a scope', () => {
    const input = fixture(codex, 'PreToolUse', 'Bash', 'rg -n sessionExpiry');
    expect(normaliseCodex(input, context)).toContainEqual({ type: 'file.search', data: { query: 'sessionExpiry' } });
  });
  it('marks a patch working before it succeeds', () => {
    expect(normaliseCodex(fixture(codex, 'PreToolUse', 'apply_patch'), context)).toEqual([{ type: 'agent.status', data: { status: 'working' } }]);
  });
  it('uses real patch completion metadata for moves and deletion', () => {
    const input = fixture(codex, 'PostToolUse', 'apply_patch', '*** Move to:');
    expect(normaliseCodex(input, context)).toEqual([
      { type: 'file.edit', data: { path: 'src/auth/codex-second.ts', op: 'delete' } },
      { type: 'file.edit', data: { path: 'src/auth/codex-moved.ts', op: 'create' } },
      { type: 'file.edit', data: { path: 'src/auth/codex-note.ts', op: 'delete' } },
    ]);
  });
  it('does not guess completion when real Bash responses lack exit metadata', () => {
    for (const command of ['true', 'exit 7']) expect(normaliseCodex(fixture(codex, 'PostToolUse', 'Bash', command), context)).toEqual([]);
  });
  it('does not mistake Bash stdout for completion metadata', () => {
    const input = fixture(codex, 'PostToolUse', 'Bash', 'true');
    for (const output of ['Process exited with code 0', 'Exit code: 0\nWall time: 0.5 seconds', '{"metadata":{"exit_code":0}}']) {
      expect(normaliseCodex({ ...input, tool_response: output }, context)).toEqual([]);
    }
    expect(normaliseCodex({ ...input, tool_response: { metadata: { exit_code: 7 } } }, context)).toEqual([{ type: 'command.done', data: { kind: 'other', exitCode: 7 } }]);
  });
  it('ignores unknown response strings and failed patch completions', () => {
    const input = fixture(codex, 'PostToolUse', 'apply_patch', '*** Move to:');
    expect(normaliseCodex({ ...input, tool_response: '[redacted]' }, context)).toEqual([]);
    expect(normaliseCodex({ ...input, tool_response: 'Exit code: 1\n[redacted]' }, context)).toEqual([]);
  });
});

describe('patch file headers', () => {
  it('parses captured absolute add and update headers', () => {
    const input = fixture(codex, 'PreToolUse', 'apply_patch', '*** Add File:');
    expect(parsePatch((input.tool_input as { command: string }).command, '/repo')).toEqual([
      { path: 'src/auth/session.ts', op: 'modify' },
      { path: 'src/auth/codex-second.ts', op: 'create' },
    ]);
  });
  it('parses captured move and delete headers', () => {
    const input = fixture(codex, 'PreToolUse', 'apply_patch', '*** Move to:');
    expect(parsePatch((input.tool_input as { command: string }).command, '/repo')).toEqual([
      { path: 'src/auth/codex-second.ts', op: 'delete' },
      { path: 'src/auth/codex-moved.ts', op: 'create' },
      { path: 'src/auth/codex-note.ts', op: 'delete' },
    ]);
  });
  it('requires an envelope and drops headers outside the worktree', () => {
    const input = fixture(codex, 'PreToolUse', 'apply_patch', '*** Move to:');
    const patch = (input.tool_input as { command: string }).command;
    expect(parsePatch(patch.replace('*** Begin Patch', ''), '/repo')).toEqual([]);
    expect(parsePatch(patch.replaceAll('/repo/', '/outside/'), '/repo')).toEqual([]);
    expect(parsePatch(patch.replace('/repo/src/auth/codex-moved.ts', '/outside/file.ts'), '/repo')).toEqual([
      { path: 'src/auth/codex-second.ts', op: 'delete' },
      { path: 'src/auth/codex-note.ts', op: 'delete' },
    ]);
    expect(parsePatch(patch.replace('/repo/src/auth/codex-second.ts', '/outside/file.ts'), '/repo')).toEqual([
      { path: 'src/auth/codex-moved.ts', op: 'create' },
      { path: 'src/auth/codex-note.ts', op: 'delete' },
    ]);
  });
});

describe('path conversion and shell boundaries', () => {
  it('uses the real absolute Claude path and a nested session cwd', () => {
    const input = fixture(claude, 'PreToolUse', 'Read').tool_input as { file_path: string };
    expect(toRelativePath(input.file_path, '/repo')).toBe('src/auth/session.ts');
    expect(toRelativePath('session.ts', '/repo', '/repo/src/auth')).toBe('src/auth/session.ts');
    expect(toRelativePath('src\\auth\\session.ts', '/repo')).toBe('src/auth/session.ts');
    for (const path of ['/repository/src/auth/session.ts', '../../secret', 'C:\\secret', '/repo', 'file:///repo/a', 'a\0b']) expect(toRelativePath(path, '/repo')).toBeUndefined();
  });
  it('reads quoted paths, tracks cd and excludes unknown files', () => {
    const input = fixture(codex, 'PreToolUse', 'Bash', 'cat src/auth/session.ts');
    const events = normaliseCodex({ ...input, tool_input: { command: 'cd src/auth && cat "session.ts" tokens.ts missing.ts session.ts' } }, context);
    expect(events.filter(event => event.type === 'file.read')).toEqual([
      { type: 'file.read', data: { path: 'src/auth/session.ts' } },
      { type: 'file.read', data: { path: 'src/auth/tokens.ts' } },
    ]);
    expect(shellTokens('cat "src/my file.ts"; pwd')).toEqual(['cat', 'src/my file.ts', ';', 'pwd']);
  });
  it('classifies common commands and truncates display commands', () => {
    for (const command of ['pnpm test', 'npx vitest run', 'cargo test', 'node --test']) expect(commandKind(command)).toBe('test');
    for (const command of ['pnpm typecheck', 'npm run build', 'tsc --noEmit']) expect(commandKind(command)).toBe('build');
    expect(commandKind('git status')).toBe('git');
    expect(commandKind('cat src/auth/session.ts')).toBe('other');
    const input = fixture(codex, 'PreToolUse', 'Bash', 'cat src/auth/session.ts');
    expect(normaliseCodex({ ...input, tool_input: { command: 'x'.repeat(300) } }, context)[0].data).toMatchObject({ command: 'x'.repeat(200) });
  });
});
