# dev-server

A read-only loopback HTTP server plus a plain harness page, for verifying the
Phase 2 live audio engine in a real browser.

```
npm run dev          # build everything, bundle the web assets, start the server
open http://localhost:4173/?project=first-track
```

Then click "click to start audio" (browsers only resume an `AudioContext` from a
user gesture — PLAN.md §14) and watch the console. Everything is logged under the
`[chord-garden]` prefix, including a verdict line that says whether the worklet's
reported peak level was ever non-zero, which is the difference between "played"
and "ran without throwing".

`window.chordGarden` exposes `start()`, `stop()` and `status()` for automation.

Query parameters: `?project=<name>`, `?seed=<n>`, `?rate=<hz>` (forces the
`AudioContext` rate instead of taking the device's).

## Why it lives here

PLAN.md §17 reserves `/sidecar` for the authenticated filesystem bridge of
Phase 4 and `/app` for the React UI of Phase 3. This is neither: it never writes,
never watches, and holds no WebSocket, and the page it serves is a test
instrument that Phase 3 replaces. Its URL shape is the read-only half of the
sidecar's `openProject`/`readAsset` protocol, so Phase 4 can adopt these routes
rather than replace them:

```
GET /api/projects                        the mounted projects
GET /api/projects/:name                  documents, their kinds, and diagnostics
GET /api/projects/:name/files/<path>     one document or sample, confined to the root
```

Confinement is enforced per segment, then by resolved path, then by real path, so
a symlink inside a project cannot serve a file outside it. Only `.json` and `.wav`
are servable. The server binds to 127.0.0.1 and refuses non-loopback `Host`
headers.

## Bundling

`npm run build:web` bundles `packages/engine/dist/live/worklet.js` into one
self-contained IIFE that `AudioWorklet.addModule` can load, and the harness page's
script into an ES module. The worklet bundle is checked at build time: it must
have no external imports left, and it must register `chord-garden-live` when
evaluated in a context that has the AudioWorklet globals and nothing else.
