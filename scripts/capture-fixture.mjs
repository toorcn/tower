#!/usr/bin/env node
// Step 0 collector. We scrub before the first write, including tool outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const repo = process.env.TOWER_CAPTURE_REPO;
  const safe = (text) => text.replaceAll(repo || '\0', '/repo').replaceAll(homedir(), '/home/user')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[secret]');
  const metadata = new Set(['session_id', 'cwd', 'hook_event_name', 'tool_name', 'tool_use_id', 'turn_id', 'source', 'reason', 'model', 'permission_mode', 'file_path', 'path', 'pattern', 'glob', 'type']);
  function scrub(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'tool_response') {
        // These commands have no stdout or file content, so their entire
        // response is safe completion metadata from the real CLI.
        if (['true', 'exit 7'].includes(payload.tool_input?.command)) return safe(value);
        try { return JSON.stringify(scrub(JSON.parse(value))); } catch { /* Plain text response. */ }
        return safe(value.split('\n').filter(line => /^(?:Chunk ID: |Wall time: |Process exited with code |Exit code: |Success\. Updated the following files:|[AMD] )/.test(line)).join('\n')) || '[redacted]';
      }
      if (key === 'prompt') return safe(value).slice(0, 500);
      if (key === 'command') return value.startsWith('*** Begin Patch')
        ? safe(value.split('\n').filter(line => /^\*\*\* (Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/.test(line)).join('\n'))
        : safe(value).slice(0, 200);
      if (metadata.has(key)) return safe(value);
      return '[redacted]';
    }
    if (Array.isArray(value)) return value.map(v => scrub(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(env|environment|environment_variables)$/i.test(k)).map(([k, v]) => [k, scrub(v, k)]));
    return value;
  }
  const tool = process.argv[2];
  if (!['claude-code', 'codex'].includes(tool)) process.exit(0);
  const dir = resolve(process.env.TOWER_FIXTURES_DIR || 'fixtures/raw', tool);
  mkdirSync(dir, { recursive: true });
  const name = String(payload.hook_event_name).replace(/[^a-zA-Z]/g, '');
  writeFileSync(resolve(dir, `${name}-${Date.now()}-${process.pid}.json`), JSON.stringify(scrub(payload), null, 2) + '\n', { mode: 0o600 });
} catch { /* Capture must fail open too. */ }
