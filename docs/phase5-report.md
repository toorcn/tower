# Phase 5 verification

We built the deterministic negotiation first and ran a full server request flow before adding the model path. We then added isolated delegate payloads and a separate split extraction call. Each delegate receives only its own edited and planned files, plus the shared task summaries, contested files and public transcript. The extraction call sees public facts and the transcript only.

We use a 3 second timeout per model call and a 6 second model preparation budget. We reserve time for the 1.5 second opening pause and 1.8 second message spacing. A failed or invalid model run emits the complete deterministic exchange instead. We fetch Anthropic Messages interface documentation with Context7 before adding the model transport.

## Checks we ran

- `pnpm typecheck`: passed.
- `pnpm test`: 97 tests passed in 12 files. Hook shim tests needed localhost socket permission outside the filesystem sandbox.
- We ran an actual Fastify server through injected HTTP requests with the key absent. We saw collision, four alternating messages, fallback proposal, accept, resolution and owner claim cleanup. A second accept returned 200 without adding events.
- We tested exact split coverage, duplicate ownership, missing files, unknown agents, editing priority, older claim priority, private context isolation, one reject retry, a second reject leaving holds open, model turn two timeout falling back, and five second auto acceptance.
- We ran an actual server with a stubbed model. Two alternating replies and a valid extraction produced a model proposal in **3.320 seconds**, including the opening pause and reading interval. This is a transport stub measurement, not a live provider latency claim.
- The actual fallback server run proposed in **6.933 seconds**. Message gaps were 1.806, 1.807 and 1.807 seconds.

## Transcript from the actual fallback server run

Collision `99bc5da1-a877-49e5-8cd2-169ae63542a9`. Both agents planned `auth.ts` and `session.ts`. Agent a declared its plan first. Agent a's task was rotation; agent b's task was expiry. These are simulator identities, not live Claude Code and Codex sessions.

> b: For expiry, I take no contested files. a takes auth.ts, session.ts.
>
> a: For rotation, I take auth.ts, session.ts. b takes the remaining task outside these files.
>
> b: Agreed: I own no contested files; a owns auth.ts, session.ts. We can continue separately.
>
> a: Agreed: I own auth.ts, session.ts; b owns no contested files. We can continue separately.

We assigned both files to a because its planned claims were older. That is sensible for preserving priority and preventing duplicate edits, and it exactly follows the fallback rule. It is not a useful division of these two overlapping tasks: b has no contested file to work on. We should not claim that this deterministic policy understands task boundaries.

## Checks still requiring a live demo

We found no `ANTHROPIC_API_KEY` in the environment. We did not verify live provider negotiation or provider latency. We did not launch real Claude Code and Codex sessions, receive split mail in those terminals, finish both demo tasks, or establish nonoverlapping worktree diffs. Injected HTTP checks and stub model replies are not evidence for those requirements. Browser visual checks and the exact simulator command are tracked separately by the coordinating agent.
