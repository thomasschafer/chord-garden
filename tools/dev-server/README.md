# dev-server

The loopback sidecar: a local HTTP server that serves a project bundle to the
browser, accepts edits back, and watches the directory so a change made outside
the app reaches it. It also serves the plain harness page used to verify the
live audio engine.

```
npm run dev          # build everything, bundle the web assets, start the server
open http://localhost:4173/?project=first-track     # the engine harness
open http://localhost:4173/app/?project=first-track # the editor UI
```

On the harness page, click "click to start audio" (browsers only resume an
`AudioContext` from a user gesture — PLAN.md §14) and watch the console.
Everything is logged under the `[chord-garden]` prefix, including a verdict line
that says whether the worklet's reported peak level was ever non-zero, which is
the difference between "played" and "ran without throwing".

`window.chordGarden` exposes `start()`, `stop()` and `status()` for automation.

Query parameters: `?project=<name>`, `?seed=<n>`, `?rate=<hz>` (forces the
`AudioContext` rate instead of taking the device's).

## Routes

```
GET  /                                   the engine harness page
GET  /app/                               the editor UI
GET  /session-token                      the token this run is using
GET  /api/projects                       the mounted projects
GET  /api/projects/:name                 documents, their kinds, and diagnostics
GET  /api/projects/:name/snapshot        every document in one response, with hashes
GET  /api/projects/:name/files/<path>    one document or sample, confined to the root
POST /api/projects/:name/write           a batch of document writes and deletions
GET  /api/projects/:name/socket          upgrades to the sync WebSocket
```

Everything under `/api/` requires the session token in the
`x-chord-garden-token` header — reads as well as writes. The two HTML pages
receive that token as an injected global, since a navigation cannot carry a
header. `/session-token` is deliberately outside `/api/` and unauthenticated: it
exposes nothing the pages do not already hand out, and it exists so that a page
open across a sidecar restart can pick up the new token rather than lose
whatever it had not yet written.

The server binds to 127.0.0.1, refuses non-loopback `Host` headers, requires an
`Origin` on any write, and marks every response `nosniff`. Path confinement is
enforced per segment, then by resolved path, then by real path, so a symlink
inside a project cannot serve a file outside it. Only `.json` and `.wav` are
servable.

## Writing and watching

A write is a batch, and it is all-or-nothing. Each file carries the hash the
editor last read; every precondition in the batch is checked before a single
byte is written, so a conflict on the last file cannot leave the first one
applied. A batch whose hashes no longer match disk is refused with 409 and
nothing is written. Files must arrive in canonical form — the server does not
reformat what it is sent.

Only one browser at a time holds the read-write session; the sidecar hands it
out over the socket and refuses writes from anyone else. The directory is
watched, with an idle re-scan behind it so a change no filesystem event
reported is still noticed, and a `projectChanged`, `samplesChanged` or
`projectInvalid` frame goes out over the socket when the disk moves.

## Why it lives here

PLAN.md §17 reserves `/sidecar` for the authenticated filesystem bridge and
`/app` for the React UI. This is now both of those, grown in place: the routes
started as the read-only half of the sidecar's `openProject`/`readAsset`
protocol and the write, watch and socket halves were added to them rather than
replacing them. The harness page at `/` is the one part that remains a test
instrument rather than a product surface.

## Bundling

`npm run build:web` bundles `packages/engine/dist/live/worklet.js` into one
self-contained IIFE that `AudioWorklet.addModule` can load, and the harness page's
script into an ES module. The worklet bundle is checked at build time: it must
have no external imports left, and it must register `chord-garden-live` when
evaluated in a context that has the AudioWorklet globals and nothing else.
