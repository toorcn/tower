# 06. Demo resilience

## Goal

The demo survives a bad room. We can run it live, and if anything fails we drop to a replay of a real run in one keystroke, then to a video, then to screenshots.

No new features in this phase. Freeze everything else before starting it.

## Depends on

Phase 5.

## The fallback ladder

| Level | What runs | When we use it |
|---|---|---|
| 1. Live | Three real agent sessions and the live server | Default |
| 2. Replay | `scenarios/golden.jsonl`, a recorded real run, played through the same UI | An agent stalls, the network drops, or the collision has not fired 40 seconds after agent B starts |
| 3. Video | A screen recording of a clean live run | The laptop or browser misbehaves |
| 4. Screenshots | Five stills in the deck | The projector or everything else fails |

## Build

### 1. Record and replay

- `pnpm log:to-scenario <log.jsonl> <out.jsonl>` converts a server log into a scenario: timestamps become offsets from the first event, long idle gaps over 4 seconds are shortened to 4 seconds, and all events (including `system`) are kept.
- `pnpm sim` already plays it in `scripted` mode.
- `pnpm demo:fallback` is a shortcut for playing `scenarios/golden.jsonl` at normal speed.
- When the server is in `scripted` mode, the web app shows a small "Replay" tag in a corner. We do not hide it. We say it is a recording of a real run.

### 2. The golden run

Do the real three-agent demo until we get three clean runs. Keep the best one as `scenarios/golden.jsonl` and commit it. A clean run means: collision fires within 15 seconds of agent B's prompt, the negotiation reads well, the split is sensible, both agents finish, and no file is changed by both.

### 3. Demo prompts

`scripts/demo-prompts.md` holds the exact prompt for each of the three terminals, tuned so that:

- Agent A reaches its first edit in `src/auth` within 20 seconds.
- Agent B's task clearly needs the same files.
- Agent C never goes near `src/auth`.
- Every task is small enough to finish in under 2 minutes.

If the tools are too slow for that, shrink the tasks, not the pacing of the map.

### 4. One-command start and preflight

`scripts/demo-start.sh`:

1. Runs `scripts/reset-demo.sh`.
2. Starts the built server (`pnpm build && pnpm start`), not the dev server.
3. Opens the browser at the map in presentation mode.
4. Prints the three terminal commands and where the prompts are.

`pnpm demo:check` prints a pass or fail line for each of:

- Server answers on `127.0.0.1:4317`.
- `tower-hook` is on the PATH, and a test payload posted through it gets a response.
- Hook config is present in each worktree for both tools.
- Each worktree is clean and on its base commit.
- `ANTHROPIC_API_KEY` is set (a warning, not a failure, since the fallback covers it).
- `scenarios/golden.jsonl` exists and parses.

It cannot tell whether Codex hooks have been trusted. Print a reminder to check that by hand with `/hooks`.

### 5. Recording and stills

- Record one clean live run of the full screen at 1080p with the three terminals visible in a strip below the map. Keep it under 90 seconds. Save as `demo/tower-demo.mp4`.
- Export five stills to `demo/stills/`: agents working, flight plan drawn, collision, negotiation, split accepted.

### 6. Polish pass, in this order, and stop when time runs out

1. Anything unreadable from 5 metres: label sizes, contrast, the alert card.
2. Timing of the collision sequence. It should feel like a jolt, then calm.
3. Roster copy: every status line should read as plain English.
4. Remove debug output from the UI and the terminals.

## Rehearsal checklist

Run the full demo five times with a timer.

- [ ] Start to collision is under 45 seconds.
- [ ] Collision to accepted split is under 30 seconds.
- [ ] Whole thing fits in 90 seconds with the closing line.
- [ ] Switching to `pnpm demo:fallback` mid-run takes under 5 seconds and looks intentional.
- [ ] Laptop on battery, wifi off: the fallback split and replay both still work.
- [ ] Notifications off, terminal font large, browser in full screen.

## The lines for the pitch

- **Open with the benefit:** "Two of our agents were about to rewrite the same file. We found out in four seconds, not at merge time."
- **Then the mechanism:** "Tower watches what every agent on the team plans to touch, holds the one that would collide, and has their delegates agree a split."
- **Be straight about the setup:** each terminal stands in for a teammate, and the negotiation is run by Tower on each agent's behalf.

## Out of scope

- New features, new animations, new event types.
- Timeline scrubbing.
- Hosting the demo anywhere.

## Done-check

1. `pnpm demo:check` passes on a fresh terminal.
2. `scripts/demo-start.sh` followed by the three prompts gives a clean live run.
3. `pnpm demo:fallback` shows the same story from the golden run, with the Replay tag visible.
4. With wifi off and no API key, the replay still plays and a live run still reaches an accepted split through the fallback.
5. `demo/tower-demo.mp4` and five stills exist and match the current UI.
6. Five timed rehearsals are logged in `demo/rehearsals.md` with what went wrong in each.

## Handoff prompt

> Read `AGENTS.md` and `specs/00-overview.md`, then build `specs/06-demo-resilience.md`. Add no features. I will run the live rehearsals myself: prepare the scripts, the preflight and the log converter, then tell me exactly what to run and in what order.
