# 02. Constellation

## Goal

Replace the bare page with the real-time constellation: files as stars, folders as clusters, agents as lights whose movement shows what they are doing. This is the thing the room looks at, so it gets the most polish of any phase.

## Visual direction update

We use a warm charcoal control-room treatment following the visual review. This overrides the original navy, glow and spectacle directions below. We keep event meanings and timing intact.

- Background: solid `#242522`. Panel: `#2B2C28`. Border: `#46473F`.
- Text: `#E7E3D8`. Secondary text: `#B1AEA2`.
- We display the six server agent colours as sage, ochre, slate, clay, lavender-grey and olive: `#A5B99A`, `#D1AA74`, `#98AEBD`, `#C79688`, `#B0A7C0`, `#C2BE8C`. This is a presentation mapping only.
- We remove dust drift, decorative cluster glows, star twinkle, particle bursts, shockwaves and screen-edge flashes.
- We keep movement, short trails, small local rings, static dashed plans, collision double rings, tethers and travelling negotiation signals.
- We keep collision rings steady. We show success through ownership colour changes and restrained local rings.
- We use compact squared panels, plain headings and visible keyboard focus.

## Depends on

Phase 1. Develop entirely against `pnpm sim scenarios/demo-full.jsonl --loop`. No live agent is needed.

## What each thing means

| On screen | Means |
|---|---|
| Star | A file. Size grows with its line count. |
| Cluster with a soft glow and a label | A folder |
| Thin lines joining stars in a cluster | Decoration only, so clusters read as constellations |
| Coloured light with a trail | An agent |
| Star tinted in an agent's colour | That agent holds the file |
| Dashed path through several stars | An agent's flight plan (files it is predicted to touch) |
| Red and white double ring on a star | Collision on that file |
| Line between two agents | They are in a negotiation |

## Build

### 1. Layout

- Group nodes by folder (first two path segments). Place cluster centres with a seeded layout so they are spread across the viewport with the largest cluster near the middle.
- Inside each cluster, run `d3-force` (collide plus a pull to the cluster centre) for 300 ticks with a seeded random source, then freeze. Positions must be identical on every load for the same graph.
- Constellation lines: a minimum spanning tree over the stars of each cluster.
- A file that appears later (a `create` edit) is placed near its cluster centre without moving existing stars.
- Fit to the viewport with padding for the side panels. Handle resize and `devicePixelRatio`.

### 2. Renderer

One full-screen `<canvas>`, Canvas 2D, one `requestAnimationFrame` loop. React renders only the panels on top.

Draw order:

1. Background: near-black blue gradient and a pre-rendered dust layer on an offscreen canvas, drifting slowly.
2. Cluster glows and labels.
3. Constellation lines, very faint.
4. Stars, with a slow random twinkle. Held stars get a halo in the holder's colour.
5. Flight plans.
6. Agent trails and heads.
7. Effects (rings, particles, shockwaves, tethers, message pulses).

Use pre-rendered glow sprites per colour and `globalCompositeOperation = 'lighter'` for anything that glows. Do not use `shadowBlur` in the frame loop.

Budget: 60 fps on a laptop with 500 stars, 6 agents and 40 live effects.

### 3. Effects engine

A small list of active effects, each `{ start, duration, draw(ctx, t) }` with `t` from 0 to 1, removed when done. No animation library.

Each agent has a queue of **beats**. A beat is one event turned into movement plus effects, with a minimum screen time so a burst of events still reads. If an agent's queue passes 8 beats, drop its oldest `file.read` beats first. Never drop edits, collisions or anything from `system`.

### 4. Event to animation

| Event | Animation | Minimum time |
|---|---|---|
| `agent.joined` | Light fades in at the edge of the map and settles into a slow orbit around the centre of the map | 800 ms |
| `intent.declared` (with files) | Dashed path draws itself through the predicted stars in the agent's colour, then stays at low opacity | 900 ms |
| `file.read` | Light travels to the star on a curved path. One thin ring pulses out from the star. | 250 ms |
| `file.search` | A sonar ring expands from the agent across the cluster named in `scope`, or the whole map | 400 ms |
| `file.edit` | Light docks on the star. The star flares, throws 12 to 20 particles and keeps the agent's tint. `create`: star is born from a point. `delete`: star dims to an outline. | 600 ms |
| `command.run` | A small ring spins around the agent while the command runs | until `command.done` |
| `command.done` | Ring snaps closed. Exit 0 with kind `test`: quick green flash. Non-zero: quick red flash. | 300 ms |
| `agent.status` idle | Light returns to a slow orbit near its last cluster | none |
| `hold.applied` | The agent's light bounces off the held star and starts circling it at a distance (a holding pattern) | 700 ms |
| `collision.detected` | Contested stars go white-hot with a red double ring, a shockwave crosses the map, the screen edge pulses once, a tether forms between the two agents | 1500 ms |
| `negotiation.message` | A bright pulse runs along the tether from the speaker to the listener | 500 ms |
| `split.proposed` | Each contested star shows a split preview: a half-ring in the colour of its proposed owner | 600 ms |
| `split.accepted` | Stars recolour to their new owner in a wave starting from the tether's midpoint, the tether dissolves, a calm green ripple spreads | 1200 ms |
| `collision.resolved` | Red rings fade. Agents in a holding pattern rejoin. | 500 ms |
| `agent.left` | Light fades out. Its tints fade over 3 seconds. | 800 ms |

Movement uses eased curved paths (quadratic bezier with a random perpendicular offset). Trails are a ring buffer of the last 40 head positions, drawn with falling opacity.

### 5. Panels (React, over the canvas)

- **Left, roster:** one card per agent with colour dot, pilot, tool, a one-line intent, and the current action in words ("editing src/auth/session.ts"). A held agent's card says "On hold" and names the file.
- **Right, feed:** recent events in plain words. During a collision this panel becomes the negotiation transcript, with each message in its speaker's colour.
- **Centre top, alert card:** appears on `collision.detected`. Names both pilots and the contested files. When a split is proposed it lists who gets what, the rationale in one sentence, and **Accept split** and **Reject** buttons that call the collision endpoints.
- **Bottom, timeline:** a thin bar with a tick per event and brighter marks for collisions. Display only in this phase.

Press `P` for presentation mode: panels shrink, labels grow, cursor hides.

### 6. Look

| Token | Value |
|---|---|
| Background | `#060913` to `#0B1022` |
| Star, unclaimed | `#C9D4F0` at 70% |
| Agent palette, in join order | `#5EEAD4`, `#F59E0B`, `#A78BFA`, `#F472B6`, `#60A5FA`, `#A3E635` |
| Collision | core `#FFFFFF`, ring `#FF4D4D` |
| Resolved | `#4ADE80` |
| Panel surface | `rgba(12, 16, 32, 0.72)` with a 1px border `rgba(255,255,255,0.08)` and backdrop blur |
| Type | system sans for panels, a monospace for file paths and labels |

A collision must be readable without colour: it also has the double ring shape and the tether. Respect `prefers-reduced-motion` by cutting particles, drift and the screen pulse.

Text must be legible from the back of a room: no label under 13px in presentation mode, and file labels show only for stars that are held, contested or under an agent.

## Out of scope

- Zoom, pan, search, filters, settings.
- 3D or WebGL.
- Scrubbing the timeline (phase 6 adds replay controls).
- Any server change other than a bug fix.

## Done-check

1. `pnpm sim scenarios/demo-full.jsonl --loop` with the page open: every row of the event table is visible at least once per loop. Check them off one by one.
2. Reload three times: stars are in the same positions each time.
3. Mid-collision reload: the tether, rings and alert card come back from the snapshot.
4. Clicking **Accept split** sends the request (visible in the network tab) and does not throw if the collision is already resolved.
5. The browser's performance panel shows a steady 60 fps through the collision sequence at 1080p.
6. `pnpm sim scenarios/demo-full.jsonl --speed 4`: nothing piles up or freezes, and the collision, negotiation and split are still shown.
7. With the OS set to reduce motion, the scene still shows state without particles or drift.
8. Take one screenshot at each of these moments and attach them to the report: two agents working, flight plan drawn, collision, negotiation, split accepted.

## Handoff prompt

> Read `AGENTS.md` and `specs/00-overview.md`, then build what `specs/02-constellation.md` describes in `packages/web`. Develop against the looping simulator. Do not change the event contract. When done, run each Done-check item, take the five screenshots it asks for, and report honestly which animations look weak so we can tune them.
