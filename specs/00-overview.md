# 00. Overview and contract

This file is the source of truth for every phase. If a phase spec disagrees with this file, this file wins.

## What we are building

Git tells a team about a conflict at merge time, after two agents have already done the work twice. Tower tells them when the second agent declares what it is about to do.

Three things happen on screen:

1. **See.** Every running agent is a coloured light moving through a constellation of the repo's files, in real time.
2. **Catch.** When a second agent's plan crosses code another agent holds, the map shows a collision and the second agent is put on hold for those files.
3. **Resolve.** A delegate for each agent negotiates a split. We accept it with one click, the stars recolour by owner, and both agents carry on.

## The demo we are building toward

Everything in every phase exists to make this 90 second run work. One laptop, three terminals, one browser window on the big screen.

| Time | What we do | What the screen shows |
|---|---|---|
| 0:00 | Agent A (Claude Code, pilot "Hong"): "add refresh token rotation to auth". Agent C (Claude Code, pilot "Wei"): "add dark mode to the settings page". | Two lights leave their orbits, visit stars, and the stars they edit take their colour. |
| 0:20 | Agent B (Codex, pilot "Sarah"): "add session expiry and log out everywhere". | B's flight plan draws as a dashed path through the auth cluster and crosses stars A holds. |
| 0:25 | Nothing. Tower acts. | Shockwave on the contested stars, a tether between A and B, an alert card. B's terminal shows it is on hold for those files. |
| 0:35 | Nothing. | Messages pulse along the tether as the two delegates negotiate. The transcript scrolls in the side panel. |
| 0:55 | Click **Accept split**. | Contested stars recolour by owner, the tether dissolves, both lights resume. |
| 1:10 | Closing line. | "Git would have told us at merge time. We knew in four seconds." |

Each terminal stands in for a teammate. Say that out loud in the pitch.

## Decisions already made

| Decision | Choice |
|---|---|
| Visual | Codebase constellation: files are stars, folders are clusters, agents are lights |
| Collision handling | Alert, then delegates negotiate, then a proposed split we accept with one click |
| Demo setup | Solo, one laptop, several sessions of Claude Code and Codex, each in its own git worktree |
| Capture | Lifecycle hooks in both tools, through one shared shim |
| Enforcement | A held file is denied at the pre-edit hook with a reason the agent can act on |
| Negotiation | Run by the server as two delegates, each seeded with its agent's live context |

## Architecture

```
 terminal 1: Claude Code (worktree A) ─┐
 terminal 2: Codex       (worktree B) ─┼─ hook shim ──POST /v1/hook──▶ ┌──────────────────────┐
 terminal 3: Claude Code (worktree C) ─┘      ▲                        │ Tower server :4317   │
                                              │ hook response          │  normalise           │
                                              └────────────────────────│  claims + collisions │
                                                (context, hold, mail)  │  negotiation         │
                                                                       │  mailbox             │
 pnpm sim scenario.jsonl ───────POST /v1/events───────────────────────▶│  JSONL log           │
                                                                       └──────────┬───────────┘
                                                                                  │ WS /v1/stream
                                                                       ┌──────────▼───────────┐
                                                                       │ Web: constellation   │
                                                                       └──────────────────────┘
```

One server process. It takes raw hook payloads, turns them into Tower events, updates state, and broadcasts every event to the browser. The hook response is also how Tower talks back to an agent.

## Repo layout

```
tower/
  AGENTS.md  CLAUDE.md
  specs/
  packages/
    shared/     event schemas and types (the contract)
    server/     Fastify server, state, collision, negotiation
    web/        Vite + React + canvas constellation
    hook/       tower-hook shim (one small Node script, no dependencies)
  scenarios/    scripted sessions as JSONL
  fixtures/     real hook payloads captured from each tool, scrubbed
  scripts/      demo repo and worktree setup, reset
```

The demo repo that the agents work on is a separate git repo outside this one (see phase 3).

## Identity

| Field | Rule |
|---|---|
| `agentId` | `"<tool>:<session_id>"`, for example `claude-code:ab12...`. Stable for a session. Server events use `"system"`. |
| `tool` | `claude-code`, `codex` or `sim` |
| `pilot` | The human this session belongs to. From env `TOWER_PILOT`, default the OS username. On one laptop we set a different pilot per terminal. |
| `repoId` | Basename of the main repo that the worktree belongs to, so all worktrees of one repo share one constellation. |
| `worktree` | Absolute path of the git toplevel for the session's `cwd` |
| `path` | Always relative to the worktree root, POSIX separators. The same file in two worktrees is the same star. |
| `color` | Assigned by the server in join order from the palette in phase 2 |

```ts
interface Agent {
  id: string; pilot: string; tool: 'claude-code' | 'codex' | 'sim';
  color: string; repoId: string; worktree: string; branch: string;
  intent?: string;
  status: 'thinking' | 'working' | 'holding' | 'idle';
  joinedAt: number; lastSeen: number;
}
```

## Events

Every event has the same envelope. The server assigns `seq` and `ts`.

```ts
interface TowerEvent {
  seq: number;      // monotonic, server-assigned
  ts: number;       // ms since epoch, server clock
  agentId: string;  // or "system"
  type: string;
  data: object;
}
```

| `type` | `data` | Source |
|---|---|---|
| `agent.joined` | `{ agent: Agent }` | session start hook |
| `agent.left` | `{ reason?: string }` | session end hook |
| `agent.status` | `{ status }` | derived |
| `intent.declared` | `{ text, predictedFiles: string[] }` | prompt hook. `predictedFiles` is `[]` first, then a second event carries the prediction |
| `file.read` | `{ path }` | read tools, or shell commands that name a known file |
| `file.search` | `{ query, scope?: string }` | search tools |
| `file.edit` | `{ path, op: 'create' \| 'modify' \| 'delete' }` | edit tools, after they succeed |
| `command.run` | `{ command, kind: 'test' \| 'build' \| 'git' \| 'other' }` | shell tool, before |
| `command.done` | `{ kind, exitCode }` | shell tool, after |
| `hold.applied` | `{ path, heldBy: agentId, collisionId }` | server, when it denies an edit |
| `collision.detected` | `{ collisionId, agentIds: [string, string], files: string[], level: 'plan' \| 'edit', summary }` | server |
| `negotiation.message` | `{ collisionId, from: agentId, text }` | server |
| `split.proposed` | `{ collisionId, assignments: { agentId, scope, files: string[] }[], rationale, source: 'model' \| 'fallback' }` | server |
| `split.accepted` | `{ collisionId, by: string }` | UI click |
| `split.rejected` | `{ collisionId, by: string }` | UI click |
| `collision.resolved` | `{ collisionId }` | server |
| `mail.delivered` | `{ to: agentId, kind: 'collision' \| 'split' }` | server, when a hook response carries the mail |

Do not add types casually. The web app animates every one of these.

## HTTP and WebSocket API

All on `http://127.0.0.1:4317`.

| Route | Purpose |
|---|---|
| `POST /v1/hook` | Raw hook payload from the shim. Body: `{ tool, pilot, branch, worktree, payload }`. Response: the JSON the shim should print as the hook's output, or `{}`. Must answer in under 300 ms. |
| `POST /v1/events` | One or many already-normalised events (simulator, replay). In `scripted` mode the server accepts `system` events too. |
| `GET /v1/state` | Snapshot: `{ mode, agents, claims, collisions, lastSeq, recentEvents }`. `recentEvents` contains the last 50 events so we can restore the feed on reload. In phase 1, each collision is `{ collisionId, events }`, retaining the scripted collision and split events. |
| `GET /v1/graph?repoId=` | File graph: `{ repoId, nodes: { path, dir, loc, ext }[] }` |
| `POST /v1/collisions/:id/accept` | Accept the proposed split |
| `POST /v1/collisions/:id/reject` | Reject it |
| `POST /v1/admin/reset` | Clear all state and start a new log file. Body `{ mode?: 'live' \| 'scripted' }`, default `live`. |
| `WS /v1/stream` | First message `{ kind: 'snapshot', state, graph }`, then `{ kind: 'event', event }` for each event. `?since=<seq>` replays from the log. |

**Modes.** In `live` mode the server detects collisions, applies holds and runs negotiations itself, and rejects `system` events from outside. In `scripted` mode it does none of that and plays whatever it is sent, which is how scenarios and replays work.

**Phase 3 capture boundary.** We validate hook requests with `HookRequestSchema` in `packages/shared`. We retain session identity, lifecycle names, prompt (500 characters), tool names, file paths, search patterns and completion metadata only. We truncate shell commands to 200 characters. For patch commands we retain file headers for every affected file and remove all hunks. We remove environment fields, file contents, transcripts and tool output before sending. We validate again at the server. The payload `tool_response` carries only a metadata object; the shim extracts this from the real Codex string response or Claude object response. We do not log raw payloads.

We retain the boolean `stop_hook_active` metadata to prevent mailbox stop loops.

We emit `command.done` only when completion metadata establishes an exit code. Codex CLI 0.163.0 sends stdout alone for Bash hooks, even when a command fails, so we cannot emit that event for its shell calls. Patch responses contain an explicit exit code and support successful edit capture. We verified these differences with real fixtures.

We start and reset in `live` mode. In phase 4, live mode maintains claims, predicts files, detects collisions, enforces holds and delivers mail. We implement negotiation and split acceptance in phase 5. Scripted replay remains available.

## Claims and the collision rule

A claim says "this agent holds this file".

```ts
interface Claim { agentId: string; path: string; mode: 'planned' | 'editing' | 'reading'; ts: number; acquiredAt?: number; }
```

- `intent.declared` with predicted files creates `planned` claims.
- A pre-edit hook or `file.edit` creates or upgrades to `editing`.
- `file.read` creates `reading`.
- Claims expire: `planned` and `editing` after 15 minutes without a refresh, `reading` after 2 minutes. An agent leaving drops its claims.

**Collision rule:** a file has `planned` or `editing` claims from two different active agents, and no accepted split covers that file. `reading` never collides. One collision per pair of agents: later files join the existing open collision.

`level` is `plan` if either claim is still `planned`, else `edit`.

## Holds

While a collision is open, or after a split is accepted, the pre-edit hook for a contested file is answered as follows:

| Situation | Hook answer |
|---|---|
| File not contested | allow (empty response) |
| Collision open, this agent has priority on the file | allow |
| Collision open, the other agent has priority | deny, with a reason: who holds it, that a split is being negotiated, and to work on other files meanwhile |
| Split accepted, file assigned to this agent | allow |
| Split accepted, file assigned to the other agent | deny, with the split summary |

We refresh `ts` for expiry and preserve `acquiredAt` for priority within the same mode. An upgrade starts a new priority timestamp so an older plan cannot steal an active edit. Older snapshots without `acquiredAt` use `ts`.

Priority on a file: an `editing` claim outranks a `planned` claim. Between two claims of the same mode, the older one wins.

`TOWER_ENFORCE` controls this: `hold` (default), `warn` (never deny, only add context), `off`.

## Mailbox

The server cannot push into a running agent. It queues mail per agent and attaches it to the next hook response for that agent as added context. Each mail is delivered once. If an agent tries to stop while it has undelivered mail, the stop hook answers with a "keep going" decision that carries the mail.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `TOWER_URL` | hook shim | Default `http://127.0.0.1:4317` |
| `TOWER_PILOT` | hook shim | Display name for this session's human |
| `TOWER_ENFORCE` | server | `hold`, `warn` or `off` |
| `TOWER_AUTO_ACCEPT` | server | Seconds before a proposed split auto-accepts. Unset means wait for the click. |
| `TOWER_MODEL` | server | Model id for prediction and negotiation. Pick a small, fast one. |
| `ANTHROPIC_API_KEY` | server | If unset, every LLM feature uses its fallback |
| `TOWER_REPO` | server | Path to the main checkout of the demo repo, used to build the file graph |

## Phases

| Phase | File | Depends on | Can run alongside |
|---|---|---|---|
| 1. Foundation | `01-foundation.md` | none | none |
| 2. Constellation | `02-constellation.md` | 1 | 3 |
| 3. Capture | `03-capture.md` | 1 | 2 |
| 4. Collision and holds | `04-collision.md` | 1, 3 (UI part needs 2) | none |
| 5. Negotiation and split | `05-negotiation.md` | 4 | none |
| 6. Demo resilience | `06-demo-resilience.md` | 5 | none |

Phases 2 and 3 only share the event contract, so they can go to two coding agents at once in separate worktrees.

## Time budget and cut order

For a 5 hour window:

| Block | Minutes |
|---|---|
| Phase 1 | 40 |
| Phases 2 and 3 in parallel | 80 |
| Phase 4 | 50 |
| Phase 5 | 45 |
| Phase 6, rehearsal, recording | 50 |
| Slack | 35 |

If we fall behind, cut in this order and stop cutting as soon as we are back on time:

1. The third agent (C). Two agents still show a collision.
2. LLM file prediction. Collisions then fire on the first contested edit, not on the plan.
3. LLM negotiation. Use the scripted fallback lines and the deterministic split.
4. Codex capture. Run both agents on Claude Code and say so.

Never cut the constellation animation, the collision moment, or the replay fallback.

## What we can and cannot claim in the pitch

- The negotiation is run by Tower. Each delegate speaks for one agent using that agent's task, the files it holds and what it has done so far. Say "a delegate for each agent". Do not say the two live sessions are talking to each other directly.
- On one laptop, each terminal stands in for a teammate. Say so.
- If we fall back to the replay, say "this is a recording of a real run".
