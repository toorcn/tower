# Phase 3 verification

We ran these checks on 2026-11-11 using Claude Code 2.1.322, Codex CLI 0.163.0, and Node 22.16.0. We built capture only. We did not change the web app or implement claims, collisions, holds or mail.

We collected and showed the Step 0 fixture summary before writing normalisers. Commit `cb81e9c` contains that initial capture. We later added real move, delete and failure cases. We now retain 22 Claude fixtures and 33 Codex fixtures. We scrub all fixtures before their first write.

## Done-check results

| Check | Result | Evidence |
|---|---|---|
| 1. Real fixtures from both tools | Pass | We captured all six lifecycle events for each tool. `fixtures/README.md` lists the observed tool names, input keys and differences. |
| 2. Hong in `demo-app-hong` | Functional pass with port qualification | We observed Hong in the browser roster. Real session `e8f57f0a-4fdc-4682-925c-30610a8c122a` emitted intent, reads of `src/auth/session.ts` and `src/auth/tokens.ts`, an edit of `src/auth/session.ts`, and test completion with exit code 0. |
| 3. Sarah in `demo-app-sarah` | Functional pass with port qualification | We observed Sarah in the browser roster. Real session `01a1ca7e-af05-7191-8068-d0b2cc7b197c` emitted intent, both auth reads, and an `apply_patch` edit of `src/auth/session.ts`. All four demo tests passed. |
| 4. Same file path across worktrees | Pass | Both real sessions emitted `file.edit` with `path: src/auth/session.ts`, `op: modify`, and `repoId: demo-app`. |
| 5. Both agents work with Tower stopped | Functional pass with timing qualification | We stopped our Tower server, then ran fresh real Claude and Codex sessions. Both read and edited successfully. We saw no Tower hook errors or output. Offline shim checks using actual session identities exited 0 with empty stdout and stderr in 765 ms and 951 ms, including process startup. |
| 6. Tests | Pass | We ran `pnpm test --maxWorkers=1 --testTimeout=30000`: 67 tests passed across six files. We cover both normalisers, patch parsing, paths, graph scanning, shared validation, capture routes, read deduplication, privacy and shim failure handling. |
| 7. Reset | Pass | We ran `TOWER_URL=http://127.0.0.1:4318 scripts/reset-demo.sh /private/tmp/tower-phase3-live`. The main checkout and all three worktrees were clean. The roster was empty, `lastSeq` was 0, and recent events were empty. We seeded the reset roster with recorded real session joins after restarting Tower. |

We generated the demo at `/private/tmp/tower-phase3-live`. We verified its exact 40 scenario source paths, three worktrees and four passing tests. Installation and tests took 8.3 seconds.

We also ran `pnpm typecheck`, `pnpm build` and `git diff --check` successfully.

## Qualifications

We attempted `pnpm dev`, but an existing Tower preview occupied ports 4317 and 5173. We left that preview running and tested our server plus the built UI on `127.0.0.1:4318`. We used the production server factory and the generated project hook configuration, with `TOWER_URL` selecting that port. We did not verify replacing the existing preview on the default ports.

We observed very high machine load. Initial concurrent checks timed out during process startup and Git discovery. We removed Git subprocess discovery from the server hook route, then ran checks serially under Node 22. The successful route test recorded hook responses below 300 ms. We kept the shim's 1,500 ms deadline. We verified silent fail-open behavior, but cannot guarantee imperceptible delay under this host load.

We used the documented Codex per-invocation hook trust option for these vetted test hooks. We did not change persistent hook trust. Normal interactive sessions still require project and `/hooks` review.

We retained a browser screenshot at `output/playwright/phase3-real-sarah.png`. It shows Hong and Sarah in the roster. We saved completed normalized event evidence at `/private/tmp/tower-phase3-completed-state.json`. These local artifacts are outside the committed source.

## Payload findings

We follow the real inputs rather than the hints in the phase spec:

- We receive Codex patch completion as a string with an `Exit code:` and `Wall time:` envelope. We extract only the exit metadata.
- We receive Codex Bash stdout alone. Real `true` and `exit 7` both return an empty string, so we cannot emit their exit codes.
- We receive Claude Write creation as `tool_response.type: create`. A successful Claude Bash PostToolUse has no explicit exit code. A real `exit 7` emitted no PostToolUse among the six subscribed events.
- We receive absolute file paths and patch headers. We convert them to relative POSIX paths and reject paths outside the worktree.
- We cap Codex SessionEnd hooks at 3 seconds because that tool's documented maximum differs from the spec's blanket 5 seconds.

We use no file watcher fallback because Codex patch hooks provide the successful edit data we need. We fake no capture events. We replayed recorded real joins only to make the reset roster nonempty for its check.
