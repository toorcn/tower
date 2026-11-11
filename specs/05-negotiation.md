# 05. Negotiation and split

## Goal

When a collision opens, a delegate for each agent negotiates who takes what. Tower turns the result into a proposed split, we accept it with one click, and both agents get their assignment and carry on.

## Depends on

Phase 4.

## How it works

```
collision.detected
   └─ wait 1.5 s (lets the collision animation land, and lets late files join)
       └─ up to 4 negotiation.message events, delegates alternating
           └─ split.proposed
               └─ we click Accept  ─▶ split.accepted ─▶ mail to both agents ─▶ collision.resolved
               └─ we click Reject  ─▶ one more round with "the humans rejected this" ─▶ split.proposed
```

## Build

### 1. Delegates

A delegate is one model call that speaks for one agent. It sees:

- Its own agent's private context: pilot, tool, task summary, files it has edited, files it plans to touch.
- The shared facts: the contested files and the other agent's pilot and task summary.
- The transcript so far.

It does not see the other agent's private context. That is what makes this a negotiation between two sides and not one model writing a script.

Instructions for each delegate, in substance:

- You represent this agent. Your aim is for both agents to finish without editing the same file.
- Reply in at most 220 characters, plain text, no greetings.
- Name files. Offer a concrete division. Give up files your agent has not started on before files it has edited.
- If the other side's last offer works, say you agree and restate it.

The held agent's delegate speaks first. Stop early when a delegate agrees. Hard cap of 4 messages.

Emit each reply as `negotiation.message`, at least 1.8 seconds apart so the room can read them.

### 2. Turning the talk into a split

One more model call reads the transcript and returns:

```ts
{ assignments: { agentId: string; scope: string; files: string[] }[]; rationale: string }
```

- `scope` is one line per agent describing its part of the work.
- `rationale` is at most 140 characters.

Validate it: exactly two assignments, one per agent in the collision, every contested file assigned to exactly one of them. If it fails, use the fallback split.

### 3. Fallback

Used when there is no key, any call takes over 3 seconds, the whole negotiation takes over 15 seconds, or validation fails.

- **Split:** a contested file goes to the agent with an `editing` claim on it. If both or neither have one, it goes to the agent with the older claim.
- **Transcript:** four fixed sentence templates filled with the pilots, task summaries and file names, so the screen still shows a short exchange.

The fallback must produce the same events with the same pacing. From the audience, both paths look the same. In the event `data`, add `source: 'model' | 'fallback'` to `split.proposed` so we can tell which ran, and show a small "fallback" tag on the alert card outside presentation mode.

### 4. Accept and reject

`POST /v1/collisions/:id/accept`:

1. Emit `split.accepted`.
2. Record the split: each contested file now has one owner. The other agent's claims on those files are removed.
3. Queue mail to both agents:

   > Tower: split agreed with Sarah's agent. You own: [files]. Your part: [scope]. Sarah's agent owns: [files], for: [scope]. Do not edit their files. If you need a change there, describe it in your final summary instead.

4. Emit `collision.resolved`.

After this, holds follow the "split accepted" rows of the overview table, so each agent can edit its own files and is refused on the other's.

`POST /v1/collisions/:id/reject`: emit `split.rejected`, then run one more negotiation round with the line "The team rejected the last split. Propose a different division." added to the shared facts. A second reject leaves the collision open with holds in place.

`TOWER_AUTO_ACCEPT=<seconds>` accepts automatically after that long. Unset means wait for the click.

Both endpoints are idempotent: a second call for a resolved collision returns 200 and does nothing.

### 5. Waking the held agent

The held agent may have finished its other work and stopped before the split lands. The stop-hook mail path from phase 4 covers the moment it tries to stop. If it has already stopped, the mail waits for its next prompt. For the demo, add a line to the alert card after accept that names any agent that is idle with undelivered mail, so we know to type "continue" in that terminal.

### 6. Web wiring

The animations exist from phase 2. Check with live events that:

- The transcript panel shows each message in its speaker's colour as it arrives.
- The alert card shows the assignments and rationale, and the buttons call the endpoints.
- After accept, the roster cards show each agent's new scope under its intent.

### 7. Tests

- Split validation: accepts a good split, rejects a missing file, a file given to both, and an unknown agent.
- Fallback split rules.
- Accept: claims updated, mail queued, events in order, idempotent.
- Reject: one retry, then stays open.
- A negotiation with a stubbed model that times out on turn 2 finishes through the fallback.

## Out of scope

- The live agent sessions messaging each other directly.
- Negotiation among three or more agents.
- Editing the split by hand in the UI.
- Merging the branches. Tower stops at "who owns what".

## Done-check

1. `pnpm sim scenarios/demo-agents.jsonl`: collision, then 2 to 4 messages, then a proposed split, all produced by the server. Click **Accept split**: stars recolour and the collision resolves.
2. Same run with `ANTHROPIC_API_KEY` unset: same sequence through the fallback, and the card shows the fallback tag.
3. Real run with Claude Code and Codex on the demo prompts: after accept, each agent's terminal shows the split mail, the held agent is now allowed to edit the files it was given, and it is still refused on the other agent's files.
4. In that run, both agents finish, and `git diff --stat` in the two worktrees shows no file changed by both.
5. Click Reject once: a second proposal arrives. Reject again: the collision stays open.
6. `TOWER_AUTO_ACCEPT=5`: the split accepts by itself after 5 seconds.
7. Time from `collision.detected` to `split.proposed` is under 15 seconds on the model path. Report the number.
8. `pnpm test` and `pnpm typecheck` pass.

## Handoff prompt

> Read `AGENTS.md` and `specs/00-overview.md`, then build `specs/05-negotiation.md`. Each delegate must see only its own agent's private context. Build the fallback first and get the full flow working on it, then add the model path. Run the Done-check, paste one real negotiation transcript into your report, and tell me whether the split it produced was sensible.
