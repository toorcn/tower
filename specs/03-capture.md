# 03. Capture

## Goal

Real Claude Code and Codex sessions show up on the map. One shim script handles the hooks of both tools, the server turns their payloads into Tower events, and a setup script prepares a demo repo with one worktree per agent.

## Depends on

Phase 1. Can be built at the same time as phase 2.

## What we know, and what to verify first

Both tools have lifecycle hooks with similar shapes. From the official docs at the time of writing:

| | Claude Code | Codex |
|---|---|---|
| Events we use | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd` | Same names |
| Payload basics | `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` | `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response` on post |
| File edits | `Edit`, `Write` and similar, path in `tool_input.file_path` | `apply_patch`, with the patch text in `tool_input.command` |
| Shell | `Bash`, `tool_input.command` | Matched as `Bash`, `tool_input.command` |
| Config | `.claude/settings.json` in the repo | `.codex/hooks.json` or `.codex/config.toml` in the repo. Hooks must be trusted once with `/hooks` inside Codex before they run. |
| Talking back | JSON on stdout: `hookSpecificOutput.additionalContext`, and for `PreToolUse` a `permissionDecision` of `deny` with `permissionDecisionReason`. `Stop` accepts `{"decision":"block","reason":...}` to keep going. | Reported as the same shapes |

The Claude Code column was read from its hooks reference. The Codex column came from a summary of its docs, not the exact text. **Treat both as hints.** References:

- Claude Code: `https://code.claude.com/docs/en/hooks`
- Codex: `https://developers.openai.com/codex/hooks`

### Step 0, before any normaliser code

1. Install a hook for every event in both tools that only appends the raw stdin JSON to `fixtures/raw/<tool>/<event>-<n>.json`.
2. Run one short real session in each tool that reads a file, searches, edits a file, creates a file and runs a shell command.
3. Scrub the fixtures (truncate prompts, remove home directory paths and anything that looks like a secret) and commit them.
4. Write down in `fixtures/README.md` the exact tool names and input keys you saw. Build everything below against those.

If you cannot start a session of either tool yourself, or Codex needs its hooks trusted by hand, stop and ask us to do that step. Do not invent fixtures.

## Build

### 1. Hook shim: `packages/hook/tower-hook.mjs`

Plain Node, no dependencies, usable as `tower-hook <tool>`.

1. Read all of stdin as JSON.
2. Work out `worktree` (`git rev-parse --show-toplevel` from the payload's `cwd`) and `branch`. Cache both in a temp file keyed by `session_id` so later calls skip git.
3. `POST ${TOWER_URL}/v1/hook` with `{ tool, pilot, branch, worktree, payload }`. Timeout 1500 ms.
4. If the response is a non-empty JSON object, print it to stdout.
5. Exit 0 in every case. Any error, timeout or bad response: no output, exit 0.

Prompts are truncated to 500 characters in the shim, before they leave the process.

### 2. Server: `POST /v1/hook`

- Create the agent on the first payload seen for a session, even if the session start event was missed.
- Map each payload to zero or more Tower events with a pure function per tool: `normaliseClaudeCode(payload)` and `normaliseCodex(payload)`. Unit test them against the fixtures.
- Answer `{}` for now. Phases 4 and 5 use the response.

Mapping:

| Hook | Tower events |
|---|---|
| Session start | `agent.joined` |
| Prompt submitted | `intent.declared` with `predictedFiles: []`, then `agent.status` `thinking` |
| Before a read tool | `file.read` |
| Before a search tool | `file.search` |
| Before an edit tool | `agent.status` `working` (the claim check is phase 4) |
| After an edit tool succeeds | `file.edit`, one per file |
| Before a shell command | `command.run`, and `file.read` for each known file the command names |
| After a shell command | `command.done` |
| Stop | `agent.status` `idle` |
| Session end | `agent.left` |

Details:

- **Paths:** convert to worktree-relative POSIX. Drop anything outside the worktree.
- **Codex patches:** parse the patch text for its file header lines (add, update, delete, and move if present) to get one `file.edit` per file. Check the header format against the fixtures. Unit test the parser.
- **Shell reads:** Codex reads files through shell commands. Split the command into tokens and emit `file.read` for tokens that match a path in the file graph. Do the same for Claude Code's shell tool.
- **Command kind:** `test` if the command matches common test runners, `build` for build or typecheck commands, `git` for git, else `other`.
- **Noise:** collapse repeated `file.read` of the same file by the same agent within 2 seconds.

### 3. Real file graph

Replace the phase 1 placeholder. On start and on `POST /v1/admin/reset`, scan `TOWER_REPO` with `git ls-files`, skip lockfiles, binaries, images and anything over 2,000 lines, and record `{ path, dir, loc, ext }`. Add a node when a `file.edit` with `op: create` arrives for an unknown path. If `TOWER_REPO` is unset, keep the phase 1 behaviour of building the graph from paths seen in events.

### 4. Demo repo and worktrees

`scripts/setup-demo.sh <target-dir>`:

1. Creates a small TypeScript app as its own git repo at `<target-dir>/demo-app`. About 40 files in `src/auth`, `src/settings`, `src/api`, `src/ui`, with a few fast unit tests. Session and token logic must be concentrated in `src/auth/session.ts` and `src/auth/tokens.ts`, so the demo collision lands on real, shared files. Use the same file paths as `scenarios/demo-full.jsonl`, so the scenarios and the real repo draw the same constellation. It must install and pass tests in under 20 seconds.
2. Commits hook config for both tools into that repo, each event pointing at `tower-hook claude-code` or `tower-hook codex`, with a 5 second timeout.
3. Creates three worktrees next to it: `demo-app-hong`, `demo-app-sarah`, `demo-app-wei`, each on its own branch.
4. Links `tower-hook` onto the PATH.
5. Prints the exact three commands to start the sessions, for example `cd demo-app-sarah && TOWER_PILOT=Sarah codex`, and reminds us to trust the Codex hooks once with `/hooks`.

`scripts/reset-demo.sh` puts every worktree back to the base commit and clears Tower state.

Any repo works with Tower. We generate one so runs are short and predictable.

### 5. Fallback if Codex hooks do not behave

If Codex payloads turn out to be missing what we need, add a file watcher on the Codex worktree that emits `file.edit` for changed files under that session's agent id, and keep the hooks only for session start, prompt and stop. Report this choice instead of silently switching.

## Out of scope

- Claims, collisions, holds, mail (phase 4).
- Any change to the web app.
- Support for other coding tools.
- An MCP server. Hooks cover capture and talking back.

## Done-check

1. `fixtures/raw/` holds real payloads from both tools and `fixtures/README.md` lists the tool names and keys seen.
2. With `pnpm dev` running, start Claude Code in `demo-app-hong` and ask it to read two files and change one: the roster shows pilot "Hong", and the feed shows `intent.declared`, `file.read`, `file.edit` with correct relative paths.
3. Do the same with Codex in `demo-app-sarah` as pilot "Sarah": same result, including edits made through a patch.
4. Editing `src/auth/session.ts` from both worktrees produces events with the same `path`.
5. Stop the Tower server and use both agents: they work as normal, with no errors and no visible delay.
6. `pnpm test` covers both normalisers, the patch parser and path conversion, all from fixtures.
7. `scripts/reset-demo.sh` returns the worktrees to clean and the roster to empty.

## Handoff prompt

> Read `AGENTS.md` and `specs/00-overview.md`, then build `specs/03-capture.md`. Do Step 0 first and show me the fixture summary before writing normalisers. If a real payload disagrees with the spec, follow the payload and note the difference. Finish by running the Done-check with real sessions of both tools and report each result.
