# Satellite Vision Scape

A playable 3D reconstruction of Pine Gap and an instrument for watching humans and AI agents act in it. See `README.md` for what it is and `docs/` for how it works.

## Commands

```sh
bun install
bun run dev
bun run typecheck && bun run lint && bun run test
bun run preview          # build for Node and serve it; `vite preview` cannot serve this app
bun run verify:secrets   # canary build: the model key must never reach the client
```

## Rules that tests enforce

- **The Free Roam simulation is deterministic.** No clock and no random number in it; a seed gives the same world to whoever plays it (`tests/freeroam-authority.test.ts`).
- **An agent acts only through the action bus.** It cannot write to the world, and a person can take the controls back at once (`tests/agent-authority.test.ts`).
- **The model key stays on the server** (`tests/agent-secret-boundary.test.ts`, `bun run verify:secrets`).
- **Numbers about Jev come from committed traces.** The race target is generated (`bun run race:build`) and a test fails if it disagrees with the trace.

## Conventions worth keeping

- A comparison prints the numbers and their difference. It does not name a winner.
- The scripted baseline is always labelled, and is never called Jev.
- The historical reference and the fiction stay visibly separate. There are no interiors, and no real access or operational detail.
- Presentation (audio, HUD, ghosts) listens to the simulation and never feeds back into it.
