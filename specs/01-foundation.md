# 01. Foundation

## Goal

A server that accepts events, keeps state, logs to disk and streams to a browser, plus a simulator that plays a scripted session. After this phase, the rest of the build can be developed and demoed with no live coding agent.

## Depends on

Nothing. Read `specs/00-overview.md` first.

## Build

### 1. Workspace

- pnpm workspace with `packages/shared`, `packages/server`, `packages/web`, `packages/hook`.
- Root scripts: `dev`, `sim`, `test`, `typecheck`, `build`, `start` as listed in `AGENTS.md`.
- `pnpm dev` runs server and web together. The Vite dev server proxies `/v1` (HTTP and WebSocket) to `127.0.0.1:4317`.

### 2. `packages/shared`

- zod schemas and inferred types for `Agent`, `Claim`, the event envelope, and the `data` shape of every event type in the overview table. Export one discriminated union, `TowerEvent`.
- Export `parseEvent(input)` that returns a typed event or throws with a readable message.
- Export the agent colour palette (values are in `02-constellation.md`).

### 3. `packages/server`

- Fastify on `127.0.0.1:4317`. Refuse to bind any other host.
- `POST /v1/events`: validate, assign `seq` and `ts`, apply to state, append to the log, broadcast.
- State reducer: a pure function `(state, event) => state` covering agents (join, leave, status, intent, lastSeen). Claims and collisions arrive in phase 4. For now the reducer stores `collision.*` and `split.*` events as they come so a scripted scenario shows up in the snapshot.
- The server only has `scripted` mode in this phase: `system` events posted to `/v1/events` are accepted as they are. Phase 4 adds `live` mode and the switch between them.
- `GET /v1/state`, `POST /v1/admin/reset`.
- `GET /v1/graph`: for now, build nodes from the distinct `path` values seen in events. Phase 3 replaces this with a real repo scan.
- `WS /v1/stream`: send the snapshot, then each event. Support `?since=<seq>`.
- JSONL log at `.tower/logs/<startTimestamp>.jsonl`, one event per line, flushed on each write. `.tower/` is gitignored.
- `POST /v1/hook` exists and returns `{}`. Phase 3 fills it in.

### 4. Simulator

`pnpm sim <file> [--speed 2] [--loop]` reads a scenario and posts each line to `/v1/events` at the right time.

Scenario line format:

```json
{"at": 1200, "agentId": "sim:hong", "type": "file.read", "data": {"path": "src/auth/session.ts"}}
```

`at` is milliseconds from the start. The simulator calls `/v1/admin/reset` first unless `--no-reset` is passed.

Write two scenarios:

- `scenarios/demo-full.jsonl`: the full 90 second arc from the overview, including the `system` events (`collision.detected`, `hold.applied`, four `negotiation.message` lines, `split.proposed`, `split.accepted`, `collision.resolved`, `mail.delivered`). Three agents, about 40 files across `src/auth`, `src/settings`, `src/api`, `src/ui`, and about 120 events with believable pacing: reads in bursts, a search now and then, edits after reads, a test run near the end.
- `scenarios/demo-agents.jsonl`: the same run with every `system` event removed. Phase 4 uses it to prove the server produces the collision itself.

### 5. `packages/web` (bare)

One page, no styling effort:

- Connection status.
- Roster: one row per agent with pilot, tool, status and intent.
- Feed: the last 50 events as text lines.
- Auto-reconnect with `?since=<lastSeq>`.

Keep the WebSocket client and a `useTowerState()` hook in their own module. Phase 2 replaces the page and keeps the hook.

### 6. Tests

- Reducer: join, leave, status, intent.
- `parseEvent`: accepts each valid type, rejects a malformed one.
- Simulator timing helper: given lines and a speed, yields the right delays.

## Out of scope

- Any canvas or animation work.
- Hook payload handling, claims, collisions, negotiation.
- Auth, persistence beyond the JSONL file, deployment.

## Done-check

1. `pnpm dev`, open `http://localhost:5173`: status shows connected.
2. `pnpm sim scenarios/demo-full.jsonl`: agents appear in the roster and the feed scrolls for about 90 seconds, ending with `collision.resolved`.
3. Reload the page mid-run: roster and feed are restored from the snapshot.
4. Kill and restart the server during a `--loop` run: the page reconnects without a manual reload, and the simulator carries on without crashing.
5. `.tower/logs/` contains one JSONL file whose line count matches the number of events sent.
6. `curl -s -X POST localhost:4317/v1/events -d '{"type":"nope"}' -H 'content-type: application/json'` returns a 400 with a readable message.
7. `pnpm test` and `pnpm typecheck` pass.

## Handoff prompt

> Read `AGENTS.md` and `specs/00-overview.md`, then build exactly what `specs/01-foundation.md` describes. Stay inside its scope. When you finish, run every item in its Done-check yourself and report the result of each one, plus anything you stubbed.
