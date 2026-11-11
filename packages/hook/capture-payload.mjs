// We send only the metadata needed to draw activity. File and tool contents stay local.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 4096) => typeof value === 'string' ? value
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]')
  .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
  .replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
  .slice(0, limit) : undefined;

export function responseMetadata(response, toolName) {
  if (typeof response === 'string') {
    // Codex Bash exposes stdout only, including on failure. It cannot prove an exit code.
    // Only the observed patch response has a completion envelope before its output.
    if (toolName !== 'apply_patch') return undefined;
    const exit = response.match(/^Exit code:\s*(-?\d+)\r?\nWall time:/);
    return exit ? { exit_code: Number(exit[1]) } : undefined;
  }
  if (!object(response)) return undefined;
  const result = {};
  if (['create', 'update', 'modify', 'delete'].includes(response.type)) result.type = response.type;
  for (const key of ['interrupted', 'is_error', 'success']) if (typeof response[key] === 'boolean') result[key] = response[key];
  if (response.isError === true || response.error) result.is_error = true;
  for (const key of ['exitCode', 'exit_code']) if (Number.isSafeInteger(response[key])) result[key] = response[key];
  if (object(response.metadata) && Number.isSafeInteger(response.metadata.exit_code)) result.metadata = { exit_code: response.metadata.exit_code };
  return result;
}

export function scrubPayload(raw) {
  if (!object(raw) || typeof raw.session_id !== 'string' || !raw.session_id || typeof raw.cwd !== 'string' || typeof raw.hook_event_name !== 'string') return undefined;
  const payload = { session_id: raw.session_id.slice(0, 256), cwd: raw.cwd, hook_event_name: raw.hook_event_name };
  for (const key of ['tool_name', 'tool_use_id', 'reason']) if (typeof raw[key] === 'string') payload[key] = text(raw[key]);
  if (typeof raw.stop_hook_active === 'boolean') payload.stop_hook_active = raw.stop_hook_active;
  if (typeof raw.prompt === 'string') payload.prompt = text(raw.prompt, 500);
  if (object(raw.tool_input)) {
    const input = {};
    for (const key of ['file_path', 'path', 'pattern', 'glob']) if (typeof raw.tool_input[key] === 'string') input[key] = text(raw.tool_input[key]);
    if (typeof raw.tool_input.command === 'string') {
      input.command = raw.tool_name === 'apply_patch'
        ? raw.tool_input.command.split('\n').filter(line => /^\*\*\* (?:Begin Patch|End Patch|(?:Add File|Update File|Delete File|Move to): .+)$/.test(line)).join('\n')
        : text(raw.tool_input.command, 200);
    }
    payload.tool_input = input;
  }
  if (raw.tool_response !== undefined) {
    const metadata = responseMetadata(raw.tool_response, raw.tool_name);
    if (metadata !== undefined) payload.tool_response = metadata;
  }
  return payload;
}
