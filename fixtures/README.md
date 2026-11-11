# Real hook fixtures

We captured these payloads on 2026-11-11 from Claude Code 2.1.322 and Codex CLI 0.163.0 in an isolated git repo. We ran real read, search, edit, create and shell operations. We captured all six lifecycle events for each tool before writing normalisers.

We replace the worktree with `/repo` and home paths with `/home/user`. We truncate prompts to 500 characters and shell commands to 200. We remove file contents, patch bodies, transcript paths, assistant text and tool output before the first fixture write. Patch commands retain only the real file headers. These are scrubbed real inputs, not invented examples.

| Tool | Name | Observed input keys |
|---|---|---|
| Claude Code | `Read` | `file_path` |
| Claude Code | `Grep` | `pattern`, `path`, `output_mode` |
| Claude Code | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| Claude Code | `Write` | `file_path`, `content` |
| Claude Code | `Bash` | `command`, `description` |
| Codex | `Bash` | `command` |
| Codex | `apply_patch` | `command` |

We observed `session_id`, `cwd`, `hook_event_name` on both tools, and `tool_use_id` on tool hooks. Prompts use `prompt`. Codex also sends `turn_id`, `model` and `permission_mode`. Both send `stop_hook_active` on Stop and `reason: other` on SessionEnd.

## Differences and configuration findings

- We receive Codex `tool_response` as a string, not an object. Patch responses start with `Exit code: 0` and `Wall time:`. We parse this completion envelope without retaining command output. Bash responses contain stdout only. Real `true` and `exit 7` both returned an empty string. We omit `command.done` when a code is unknown. We do not parse arbitrary stdout as an exit code.
- We receive Claude Bash success as an object with `stdout`, `stderr`, `interrupted`, `isImage` and `noOutputExpected`, with no explicit exit code. We treat a successful, uninterrupted PostToolUse without an explicit code as zero.
- We receive Claude Write `tool_response.type: create`. We use this field to distinguish creation from overwrite.
- We receive absolute paths in Claude `file_path` and Codex patch headers. We resolve them against the worktree and reject escapes.
- We observe `*** Update File:` and `*** Add File:` in the initial Codex capture. We also captured real `*** Move to:` and `*** Delete File:` operations in a second session. We retain the headers and remove all hunks. A failed patch emitted PreToolUse but no PostToolUse.
- We saw no Codex hooks with `exec --ignore-user-config` and project hook files alone. We captured successfully with explicit per-invocation hook configuration and `--enable hooks`. We used the documented `--dangerously-bypass-hook-trust` only for vetted capture commands in this automation, without changing persistent hook trust. Interactive demo sessions still require `/hooks` review.
- We set Codex SessionEnd timeout to 3 seconds because its documented maximum is 3, rather than the spec's blanket 5 seconds.

We use `scripts/capture-fixture.mjs` as the capture-only collector. We do not read session transcripts or environment values into fixtures.
