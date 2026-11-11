# Tower: rules for coding agents

Tower is a live map of every coding agent working on a repo. It shows what each agent is doing as an animated constellation, catches two agents heading for the same code before either has wasted work, and brokers a split between them.

"Tower" is a working name. Do not spend time on naming or branding.

## Read before you write code

1. `specs/00-overview.md` is the contract. Event types, endpoints, ports and identity rules live there.
2. The spec file for the phase you were given (`specs/01-*.md` to `specs/06-*.md`).

Build one phase per session. Do not start the next phase unless asked.

## Hard rules

- **The contract is `packages/shared`.** Every event that crosses a process boundary is validated against the zod schemas there. If a phase needs a new event type or field, change `packages/shared` and `specs/00-overview.md` in the same commit.
- **Hooks fail open.** The hook shim must never break, slow or block a coding agent because Tower is down or slow. On any error or timeout it exits 0 with no output. It never exits 2.
- **Localhost only.** The server binds `127.0.0.1`. No auth, no login, no accounts, no deployment config.
- **No database.** State is in memory plus an append-only JSONL log.
- **Build the demo path only.** Each spec has an "Out of scope" list. Treat it as a ban, not a suggestion.
- **LLM calls are optional at runtime.** Every feature that calls a model must have a deterministic fallback and a 3 second timeout, so the demo runs with no network.
- **Verify external interfaces before coding against them.** Hook payloads for Claude Code and Codex change between versions. Capture a real payload into `fixtures/` first, then write the normaliser against the fixture. Do not trust field names from memory or from these specs over a real payload.
- **Scrub what you store.** Truncate prompts to 500 characters and commands to 200 before they enter an event. Never write environment variables or file contents into events, logs or fixtures.

## Stack

- Node 20+, TypeScript (strict), pnpm workspaces
- Server: Fastify, `@fastify/websocket`, `@fastify/static`, zod
- Web: Vite, React, one full-screen Canvas 2D for the constellation, `d3-force` for layout only
- Tests: vitest, for pure logic (claims, collision rule, normalisers, patch parsing)

Do not add other frameworks, state libraries, CSS frameworks or 3D libraries without asking.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Server on `127.0.0.1:4317` and web dev server on `5173` |
| `pnpm sim <scenario>` | Plays a scripted scenario into the server |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` across packages |
| `pnpm build && pnpm start` | Server serves the built web app on `4317` |

## Definition of done for a phase

1. Every item in the phase's "Done-check" passes, and you ran it yourself.
2. `pnpm typecheck` and `pnpm test` pass.
3. You report what you built, what you verified and how, and anything you could not verify. If something is stubbed or faked, say so plainly.

## Writing style for docs and UI copy

Plain words, short sentences, no em dashes, first-person plural ("we") in docs.
