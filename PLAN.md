# Agent-Native Electronic Music Tool — Design & Implementation Plan

> Status: design spec, ready for an agent to begin Phase 0.
> Audience: an AI coding agent (Claude Code / Codex) plus the human maintainer.
> Phase 0 creates `docs/format-spec.md` and `AGENTS.md`. After that, agents must read those files before editing project bundles.

---

## 1. The one-sentence thesis

A web-based electronic music tool whose **source of truth is a human- and agent-readable project document on disk**, where the graphical UI and an AI agent are *two equal editors* of that same document, kept in sync live.

A human composes in the UI. An agent (Claude Code, Codex, or later an in-app assistant) edits the same files. Neither is privileged; the document is. This is the single decision everything else hangs off, so it is specified first and in the most detail.

---

## 2. What we learned from prior art (and why this shape is right)

Three lineages were examined:

1. **MCP-into-DAW** (AbletonMCP, reaper-mcp): an agent drives a running DAW's API by remote control. Powerful, but the DAW's in-memory session is the truth and the agent pokes at it through a narrow RPC surface. There is no durable, diffable artifact the agent reasons over. We are deliberately *not* doing this.
2. **Live-coding** (Sonic Pi, TidalCycles, **Strudel**): music *is* text. Strudel's "mini-notation" (`"bd*4"`, `"a b [c d]"`, Euclidean `"(3,8)"`) is the best existing proof that rhythm and melody compress into short, legible strings an LLM handles well. We borrow its density for *patterns* but reject its cycle-relative timing model (confusing next to a bar/beat UI).
3. **Symbolic-music LLM work** (ComposerX, CoComposer): repeatedly uses **ABC notation** / **LilyPond** as interchange precisely because they are text an LLM can emit directly. Validates "text source of truth," but these are *score* notations (staves, classical) and a poor fit for grids, drum samples, synth parameters, and automation.

**Conclusion:** the agent-native, file-as-truth approach is genuinely under-explored versus the MCP-bolt-on approach, and is better aligned with the goal. We invent a small bespoke format, but steal the good ideas: Strudel's pattern density, REAPER's proof that a plain-text project format survives for decades — and REAPER's portability mistake (absolute sample paths that break when a project moves) which we avoid by keeping everything project-relative.

---

# PART ONE — THE WHAT (the interface)

The format *is* the product's API. It is the highest-leverage and hardest-to-change decision, so Phase 0 builds and stabilises it before any UI or audio exists.

## 3. Core abstraction

```
        ┌─────────────────────────────────────────────┐
        │   CANONICAL DOCUMENT MODEL  (in memory)      │  ← validated runtime projection
        └─────────────────────────────────────────────┘
            ▲  parse / serialize            ▲  bind
            │  (deterministic, lossless)    │
   ┌────────┴─────────┐            ┌────────┴─────────┐
   │  PROJECT ON DISK │            │     WEB UI       │
   │  (the artifact)  │            │  (one editor)    │
   └──────────────────┘            └──────────────────┘
            ▲
            │ edits files directly, no special integration
   ┌────────┴─────────┐
   │   AI AGENT       │  (another editor)
   └──────────────────┘
```

The **project on disk is the durable source of truth**. The in-memory model is a validated runtime projection of that document, used by the UI and audio engine while the app is open. The serializer is **deterministic**: the same model always produces byte-identical files. This is what makes clean diffs and stable round-trips possible.

A critical consequence for the agent integration: **for local use there is no agent-specific code at all.** The agent just edits files with its normal tools; a file watcher notices and updates the UI. We build a good format and a good watcher, not an "agent mode."

## 4. Project layout: a directory, not a single file

A project is a *bundle* (a directory), not one monolithic file:

```
my-track/
  project.json          # global meta: tempo, time sig, key, swing, track order
  tracks/
    drums.json          # one file per track  → surgical edits, clean per-track diffs
    bass.json
    pad.json
  patterns/
    drums-verse.json
    bass-main.json
  instruments/
    drumkit-main.json
    bass-synth.json
    pad-synth.json       # synth/patch definitions (reusable)
  arrangement.json       # timeline: which pattern plays where
  samples/               # project-relative audio (NEVER absolute paths)
    kick.wav
    hat.wav
  project.lock           # optional: written by whoever holds the edit (advisory)
```

Why a directory:
- **Surgical edits.** An agent changing the hi-hats touches only `patterns/drums-verse.json`.
- **Clean diffs / git-native.** "Agent changed the hat pattern on bars 5–8" is a small, legible change, not noise in a 5,000-line blob.
- **Fewer collisions.** UI and agent rarely touch the same file at the same instant.
- **Portability.** Samples live inside the bundle, referenced relatively, so moving/zipping the folder never breaks (the REAPER lesson).

Provide a **single-file export** (`my-track.zip` or a flattened `.json`) for sharing/portability, but the directory is the working format.

Reference and path rules:
- IDs are lowercase kebab-case ASCII: `^[a-z][a-z0-9-]*$`.
- File names should match object IDs (`patterns/bass-main.json` contains `"id": "bass-main"`).
- Project-relative paths must never be absolute and must never contain `..`.
- Unknown JSON fields are validation errors unless the schema explicitly marks an extension point.
- Orphan files are warnings in early development and errors once migration/versioning exists.

## 5. Format choice (decided, with the alternatives on record)

**Container: JSON, governed by a published JSON Schema.**
- Authoring is tolerant (accept JSON5 — comments, trailing commas — on read).
- Writing is **canonical readable JSON**: UTF-8, no comments, no duplicate keys, deterministic key order, 2-space indent, trailing newline, normalised number formatting, and no non-finite numbers. A `fmt` command (think `prettier`/`rustfmt`) makes every writer converge on identical bytes → clean diffs.
- Comments/annotations are **first-class fields** (`"description"`, `"notes"`) rather than free-floating `//`, so the canonical serializer never has to preserve trivia. This sidesteps the entire format-preserving-parser problem.

Canonicalisation is **JCS-inspired, not raw RFC 8785 JCS**. RFC 8785 is useful because it defines deterministic JSON by constraining JSON to an interoperable subset and using stable primitive serialisation + property ordering. This product deliberately keeps pretty 2-space output and may use schema-specific key order for readability. Hashes must therefore use `musictool fmt` output, not a generic JSON library's output.

Use **JSON Schema Draft 2020-12** for schemas. Prefer closed objects (`unevaluatedProperties: false`) once extension points are deliberately modelled, use `prefixItems` for tuple-shaped arrays such as `[tick, value]`, and keep semantic validation in code where JSON Schema is the wrong tool. If using Ajv, use the 2020-12 entry point (`ajv/dist/2020`) and add a test that proves `prefixItems` and `unevaluatedProperties` are actually enforced.

**Patterns inside the JSON use compact strings, not deep nesting.** A drum lane is a string, not 16 objects:

```json
{ "lane": "kick",  "steps": "x..x ..x. x..x ..x." }
```

These strings have their own small grammar (Strudel-inspired) with a dedicated parser + validator. Keep the grammar **bar/tick-absolute**, not cycle-relative — a UI sequencer thinks in bars/beats/steps, and Tidal's "events fill a cycle" model is powerful but confusing next to a piano roll.

**Why JSON Schema specifically:** it is *one shared contract* used by (a) the `validate` CLI, (b) the agent (hand it the schema and it edits correctly), and (c) the UI's type bindings (generate TS types from the schema). Universal parsers in every language. The usual JSON complaints (verbosity, no comments, noisy reformatting) are neutralised by canonical formatting + structured comment fields + compact pattern strings.

**Canonical implementation choice for Phase 0:** implement parser, formatter, validator, pattern parser, and CLI in one TypeScript workspace package (`/packages/format`) and reuse that exact package in the UI. Do **not** maintain separate Rust and TypeScript canonical serializers in v1. Rust can enter later for DSP, sidecar, Tauri, or a future WASM-backed format core if there is a measured need.

Type generation is useful but not magic. Validate the chosen JSON-Schema-to-TypeScript generator against the real schemas in Phase 0, especially tuple arrays (`prefixItems`) and closed composed objects (`unevaluatedProperties`). If the generator cannot represent the schema accurately, hand-write the public domain types and test them against schema fixtures instead of weakening the schema.

Versioning and migrations:
- `project.json` contains `"format": 1`.
- `musictool validate` rejects projects with a newer unknown format.
- `musictool migrate <project>` is not required in Phase 0, but the schema should reserve enough structure for it. Do not silently migrate on open.
- Breaking schema changes increment `format`. Non-breaking additive changes must still preserve deterministic formatting.
- Golden fixtures must include the current version number so accidental schema drift is visible in diffs.

Engine parameter registry:
- Engine-specific params are not arbitrary open JSON. Each built-in engine (`basic-mono`, `basic-poly`, `drumkit`) must declare a parameter registry with valid names, value type, min/max or enum, default, units, whether it is automatable, and comparison epsilon if numeric.
- Instrument `params` use the registry to validate flat dotted keys such as `"filter.cutoff"`.
- Automation `param` values must reference an automatable registry entry on the target track's instrument.
- Unknown params are validation errors with "did you mean" diagnostics where possible (`fitler.cutoff` should not silently pass).
- Third-party engines later need a plugin registry or explicit extension mechanism; do not weaken built-in validation to prepare for them prematurely.

**Alternatives considered and rejected:**
- **TOML** — reads beautifully for config, but arrays-of-tables get ugly for hundreds of events; no universal schema story.
- **Bespoke DSL** (full mini-notation document) — maximally compact, but you maintain a parser *and* face hard lossless round-tripping when the UI rewrites it.
- **ABC / LilyPond / MusicXML** — score-oriented; wrong primitives for grids, samples, synth params, automation.

## 6. The musical requirements drive the schema (do not let "agent-legible" distort it)

The most common failure when designing a tidy text schema is under-modelling timing and expression, then discovering it only when something sounds robotic. Bake these in from the start:

- **Timing resolution: integer ticks, not floats and not just grid steps.** Use PPQN (e.g. 960 ticks per quarter note). A note has an absolute `startTick` and `durationTicks`. Automation points, clip positions, pattern lengths, offsets, and micro-timing are all ticks. A 16th-step grid is a *view*, not the storage model. This is what lets swing, groove, and micro-timing exist at all.
- **Per-note expression:** velocity, micro-timing offset (± ticks), gate length, probability (0–1), and ratchet/repeat count.
- **Swing / groove:** global and per-pattern.
- **Automation:** parameter lanes (filter cutoff, volume, send, any synth param) as breakpoint curves over time, with interpolation type.
- **Key/scale (optional):** enables scale-aware agent edits and UI snapping.

Persisted musical time uses these conventions:
- `ppqn` lives in `project.json` and is fixed for the project. Do not change it after project creation unless a migration rewrites every tick value.
- `ticksPerBar = ppqn * 4 * timeSignature[0] / timeSignature[1]`. With 960 PPQN and 4/4, one bar is 3840 ticks.
- Pattern-local events use ticks from the start of the pattern.
- Arrangement clips use ticks from the start of the song.
- UI labels may show bars/beats/steps, but files store ticks.
- Timeline fields use JSON Schema `integer` plus semantic validation and `fmt` normalisation. Inputs like `3840.0` may parse to a number, but canonical output must write `3840`.
- Floating point values are allowed for musical parameters (`velocity`, `probability`, gains, filter values), not for timeline positions. Canonical output uses JavaScript's shortest round-trip number representation. Semantic comparisons of parameter values should either compare canonicalised values or use an explicit per-parameter epsilon from the parameter registry.

Tempo and meter:
- V1 supports a single effective tempo and meter, but the format should reserve map-shaped fields now because tick→seconds conversion depends on them.
- `project.json` has `tempoMap` and `meterMap`, each starting at tick 0. In v1, validators require exactly one point in each map and require them to match the convenience `tempo` / `timeSignature` fields if those fields remain.
- Later tempo ramps add `interp` to tempo points; meter changes remain step changes.
- Renderers and schedulers must read the map shape even if v1 only contains one point.

If the schema can't represent swing and micro-timing, the output will sound quantised and lifeless no matter how good the synths are. If the schema mixes tick integers with beat floats, the agent will make subtle alignment mistakes. Avoid that from day one.

### 6.1 Pattern-string grammar v1

Pattern strings are compact **grid views** over the tick model. They must parse into deterministic tick events.

For v1, keep the grammar intentionally small and **placement-only**:
- `x` = trigger at this grid step.
- `.` = rest at this grid step.
- Spaces are visual separators only and do not count as steps.
- `|` is an optional bar separator. It must fall on a bar boundary if present.
- `X` may be accepted on read as a convenience for an accented trigger, but `fmt` must canonicalise it to lowercase `x` plus a `stepEvents` velocity override. If that conversion is not implemented, reject `X` in Phase 0.
- `-` = tie/hold marker for future melodic grids; invalid in drum lanes until implemented.

Every lane with `steps` must declare a grid:

```json
{
  "lane": "kick",
  "grid": { "stepsPerBar": 16 },
  "steps": "x..x ..x. x..x ..x.",
  "defaults": { "velocity": 0.8 },
  "stepEvents": [
    { "step": 6, "velocity": 0.55, "probability": 0.8 },
    { "step": 11, "microTicks": -12, "ratchet": 2, "gateTicks": 120 }
  ]
}
```

This split is deliberate:
- `steps` says **where hits exist**.
- `defaults` supplies lane-level expression for all hits.
- `stepEvents` supplies sparse per-step expression overrides.
- Rich expression does not require a second event-list representation, and the string stays easy for agents to edit.

Validation rules:
- Count only non-space, non-`|` symbols as steps.
- Required step count is `stepsPerBar * patternBars`, where `patternBars = lengthTicks / ticksPerBar`.
- `lengthTicks` must be an integer multiple of a bar for v1 grid patterns.
- Each grid step maps to `stepIndex * ticksPerBar / stepsPerBar` within its bar. This must be an integer; reject grids that do not divide cleanly into ticks.
- `stepEvents[*].step` is zero-based within the pattern, must point at an `x` step, and must be unique.
- `microTicks` is applied after swing/groove. `ratchet` is a positive integer count. `gateTicks` is a positive integer duration override. `probability` is 0–1.
- Advanced Strudel-like features (`*`, Euclidean `(3,8)`, nested groups, random choice, probability syntax) are explicitly out of v1. Add them only after the basic grammar has golden tests.

Canonical pattern formatting:
- `fmt` lowercases all `x` symbols and emits `steps` as the canonical placement string. If `X` is accepted on read, it becomes `x` plus a `stepEvents` velocity override of `1.0`.
- Within each bar, group steps in blocks of four when `stepsPerBar` is divisible by four. Use ` | ` between bars. Example for one 16-step bar: `"x..x ..x. x..x ..x."`.
- If `stepsPerBar` is not divisible by four, group by the largest divisor of `stepsPerBar` that is `<= 4` and `> 1`; if no such divisor exists, emit the bar with no internal spaces.
- Do not preserve arbitrary spacing from input; `fmt` owns spacing.
- Sort `stepEvents` by `step`, then canonical key order. Do not emit empty `stepEvents`.

Pattern representation rules:
- A pattern is either `kind: "grid"` with `lanes`, or `kind: "notes"` with `notes`. Do not allow both in v1.
- Drum tracks use grid patterns in v1.
- Melodic tracks use note event-list patterns in v1.
- Melodic grid patterns and ties are future work and must not be accepted until their canonical form is specified.

## 7. Separate the *musical document* from *engine state*

Only the musical document persists to disk:

| Persists to file (document) | Runtime only (engine state) |
|---|---|
| tempoMap, meterMap, key, swing | playhead position |
| tracks, instruments, patterns | audio buffers, voice allocation |
| arrangement / timeline | undo/redo stack |
| automation, per-note expression | current selection |
| mixer levels, sends, FX params | live solo/mute (debatable — may persist) |

Keeping this boundary clean is what keeps the agent integration sane: the agent edits the document, never the engine.

## 8. Worked example (the thing to pressure-test first)

`project.json`:
```json
{
  "format": 1,
  "name": "first track",
  "tempo": 124,
  "tempoMap": [
    { "startTick": 0, "bpm": 124 }
  ],
  "timeSignature": [4, 4],
  "meterMap": [
    { "startTick": 0, "timeSignature": [4, 4] }
  ],
  "ppqn": 960,
  "key": { "root": "A", "scale": "minor" },
  "swing": 0.0,
  "trackOrder": ["drums", "bass", "pad"]
}
```

`tracks/drums.json` (sample-based, grid view):
```json
{
  "id": "drums",
  "type": "drumkit",
  "instrument": "drumkit-main",
  "patterns": ["drums-verse"]
}
```

`instruments/drumkit-main.json`:
```json
{
  "id": "drumkit-main",
  "type": "drumkit",
  "kit": {
    "kick": { "sample": "samples/kick.wav" },
    "hat": { "sample": "samples/hat.wav" }
  }
}
```

`tracks/bass.json`:
```json
{
  "id": "bass",
  "type": "instrument",
  "instrument": "bass-synth",
  "patterns": ["bass-main"]
}
```

`instruments/bass-synth.json`:
```json
{
  "id": "bass-synth",
  "type": "synth",
  "engine": "basic-mono",
  "params": {
    "oscillator": "saw",
    "filter.cutoff": 800,
    "filter.resonance": 0.2
  }
}
```

`tracks/pad.json`:
```json
{
  "id": "pad",
  "type": "instrument",
  "instrument": "pad-synth",
  "patterns": []
}
```

`instruments/pad-synth.json`:
```json
{
  "id": "pad-synth",
  "type": "synth",
  "engine": "basic-poly",
  "params": {
    "oscillator": "triangle",
    "filter.cutoff": 1200,
    "attack": 0.4,
    "release": 1.2
  }
}
```

`patterns/drums-verse.json`:
```json
{
  "id": "drums-verse",
  "kind": "grid",
  "lengthTicks": 3840,
  "lanes": [
    {
      "lane": "kick",
      "grid": { "stepsPerBar": 16 },
      "steps": "x..x ..x. x..x ..x."
    },
    {
      "lane": "hat",
      "grid": { "stepsPerBar": 16 },
      "steps": "x.x. x.x. x.x. x.x.",
      "defaults": { "velocity": 0.6, "swing": 0.12 },
      "stepEvents": [
        { "step": 2, "velocity": 0.35, "probability": 0.8 },
        { "step": 8, "microTicks": -12, "ratchet": 2, "gateTicks": 120 }
      ]
    }
  ]
}
```

`patterns/bass-main.json` (melodic, event list — pitch, start tick, duration ticks, velocity):
```json
{
  "id": "bass-main",
  "kind": "notes",
  "lengthTicks": 7680,
  "notes": [
    { "pitch": "A1", "startTick": 0,    "durationTicks": 720, "velocity": 0.9 },
    { "pitch": "A1", "startTick": 960,  "durationTicks": 480, "velocity": 0.7, "microTicks": -8 },
    { "pitch": "C2", "startTick": 2400, "durationTicks": 960, "velocity": 0.8, "probability": 0.8 }
  ]
}
```

`arrangement.json` (timeline):
```json
{
  "lengthTicks": 61440,
  "clips": [
    { "track": "drums", "pattern": "drums-verse", "startTick": 0,     "repeatCount": 16 },
    { "track": "bass",  "pattern": "bass-main",   "startTick": 15360, "repeatCount": 6 }
  ],
  "automation": [
    { "track": "pad", "param": "filter.cutoff",
      "points": [ [0, 200], [30720, 4000], [61440, 800] ], "interp": "linear" }
  ]
}
```

The first real task (Phase 0) is to build *exactly this example*, write the schema that validates it, and prove parse→serialize is idempotent. If an implementation cannot validate this fixture and reject deliberately broken variants of it, Phase 0 is not done.

## 9. The agent contract

Give the agent a fast feedback loop and a written contract. Ship in-repo:

- `docs/format-spec.md` — the format, with examples (this section, expanded).
- `AGENTS.md` — how to edit a project safely, how to validate, common mistakes.
- A CLI (see §13) the agent runs to **verify its own edits** without a human or a browser.

Agents are dramatically more reliable with a verification loop. `validate` + `doctor` + `describe` are the Phase 0 loop; `render` joins that loop in Phase 1.

---

# PART TWO — THE HOW (implementation)

## 10. Architecture & data flow

```
   AI agent ──edits──▶  files on disk  ◀──watch/write──  SIDECAR (fs authority)
                                                              │ WebSocket
                                                              ▼
                                              ┌────────────────────────────┐
                                              │  WEB APP (browser)         │
                                              │                            │
                                              │  Document store (canonical │
                                              │   model) ──┬── UI views    │
                                              │            └── Audio engine│
                                              └────────────────────────────┘
```

- The **document store** holds the canonical model; UI and audio engine both read it.
- The **sidecar** is the only thing the browser uses to touch the filesystem. It watches the project directory and pushes changes to the browser; it receives writes from the browser and persists them. It also serves project-local sample files to the audio engine through a constrained asset endpoint. The agent edits files directly; the sidecar sees those edits and notifies the browser. *No agent-specific code path exists.*

Sidecar security model for v1:
- Bind only to loopback (`127.0.0.1` / `::1`), never a public interface.
- Generate an unguessable session token at sidecar startup and require it on every WebSocket/HTTP request. For browser WebSockets, prefer first-message authentication or `Sec-WebSocket-Protocol`; do not put the token in the URL query string.
- Validate the `Host` header against the expected loopback host/port to reduce DNS rebinding risk.
- Validate the browser `Origin` header against the Vite/app origin in development and the packaged app origin in desktop builds. Treat Origin as one check, not the only check.
- Enforce project root confinement on every path: resolve, normalise, reject absolute paths, reject `..`, reject symlink escapes unless explicitly allowed later.
- Add message size limits and reject unknown protocol message types.
- Use atomic writes: write to a temp file inside the project, fsync where practical, then rename.
- Never expose a generic "read any file" or "write any file" RPC.

## 11. Tech stack (with rationale)

- **App:** TypeScript + **React** + **Vite**. React for the breadth of agent training data (the agent will write most UI); note Svelte is arguably a better fit for fine-grained audio-reactive state if you prefer — flagged, not chosen.
- **State:** a single document store (Zustand or similar) — lightweight, easy for an agent to reason about, no boilerplate.
- **Audio:** Web Audio API + **Tone.js** for the transport, scheduling, and stock synths/effects (fastest path); **AudioWorklet** for custom low-latency DSP; **Rust → WASM** for heavy synthesis (plays to your strengths). Isolate the engine behind an interface so the Tone.js core can later be swapped for the WASM engine without touching the UI.
- **Format package + CLI:** TypeScript first. This owns JSON5 read, canonical JSON write, JSON Schema validation, semantic validation, pattern parsing, `fmt`, `validate`, and `describe`.
- **Sidecar:** Node first for speed and shared TypeScript types, with the protocol designed so a Rust/Tauri backend can replace it later. It exposes a small authenticated protocol: `openProject`, `writeFile`, `readAsset`, server-push `fileChanged`, `fileRemoved`, `diagnosticsChanged`.
- **DSP / future Tauri backend:** Rust crate(s), introduced after the format and MVP engine are proven.
- **Schema → types:** generate TS types from JSON Schema only after proving the generator handles this schema's 2020-12 features. Use the generated or hand-written domain types in the format package, app, engine boundary, and sidecar protocol.

## 12. Two-way live sync (the genuinely hard part — own this code yourself)

Mechanism:

1. **UI edit** → mutate model → serialize affected files (canonical) → enqueue a write batch → **debounced** write (~250 ms) via sidecar → record `{batchId, file, revision, writeId, contentHash}` for each file.
2. **Sidecar write batch** → validate path confinement for every file → write each file atomically → emit one batch acknowledgement with new sidecar revisions.
3. **Watcher fires** → coalesce filesystem events for a short settle window (~100 ms) → read changed files → if file hashes/write acknowledgements match the last write batch *we* made, it's our own echo → ignore. Otherwise treat it as an **external edit** (agent or hand-edit).
4. **External edit v1** → reparse changed files, rebuild affected project indexes, validate project-level invariants, then replace the affected model objects file-by-file. Preserve UI selection and expanded/collapsed state by stable IDs where possible. Do *not* promise minimal semantic patches in v1.
5. **Later refinement** → compute semantic model-domain patches (`setNote`, `replaceLaneSteps`, `setParamPoint`, `addClip`) only where they clearly improve undo or collaboration. JSON Patch paths are too low-level to be the primary undo/scheduler contract.
6. **During playback:** the scheduler reads immutable snapshots of the model each lookahead tick. Parameter tweaks can affect the next scheduling window. Structural changes (pattern length, clip add/remove, track routing) are queued to the next bar boundary unless playback is stopped.

Concurrency policy (keep simple in v1, document clearly): if the UI has in-flight unsaved edits when an external edit lands on the same file, last-writer-wins with a visible warning and a retained diagnostic that names the file. The `project.lock` is advisory — an agent can be asked (via `AGENTS.md`) to check it. Real merge/CRDT is a later concern; the per-file split already makes most collisions unlikely.

Undo policy: UI undo/redo applies only to local UI edit history. An accepted external edit becomes a new baseline and is not undone by pressing Undo. If an external edit lands while undo history exists, retain the history only when object IDs still resolve cleanly; otherwise clear the affected history segment and show a diagnostic.

Cross-file transactions: some UI operations must update multiple files. The sidecar protocol therefore needs write batches even though each file is written atomically. Watcher-side validation should tolerate transient invalid states during the settle window, but the browser should only accept a new project snapshot after project-level validation passes. Invalid external edits should surface diagnostics and keep the last valid in-memory model active.

Echo-detection by content hash/write ID is the linchpin — without it you get infinite write/watch loops. Get this right first in Phase 3.

## 13. The CLI (agent's feedback loop + the test harness)

```
musictool validate <project>      # JSON Schema + pattern-grammar + semantic checks
                                   #   (referenced instrument exists, pattern length sane, etc.)
musictool fmt <project>           # canonical formatter → identical bytes from any writer
musictool describe <project>      # human/agent summary: tracks, bars, key, density
musictool doctor <project>        # validation plus actionable diagnostics and suggested fixes
musictool render <project> [--out out.wav] [--bars 0-8]
                                   # offline render so the agent can verify it made sound,
                                   #   and so tests can assert on audio output (Phase 1)
```

Diagnostics must include file path, JSON pointer or pattern-string span, line/column where available, severity, and a short suggested fix. Agents act much more reliably when they can run one command and see exactly where a mistake is.

`render` should run headless eventually. Tone.js has an offline rendering API (`Tone.Offline`) built on `OfflineAudioContext`, but Node/headless sampler behavior should be proven with a Phase 1 spike before it becomes the only regression-test path. Acceptable v1 render paths, in order of implementation likelihood:
- Browser-based Playwright render harness using the real Web Audio implementation.
- Tone offline rendering in a browser context.
- Tone offline rendering in Node if a spike proves sample loading and transport scheduling work reliably.
- Later Rust/WASM engine render.

## 14. Audio engine specifics (the other code to own)

- **Scheduler:** lookahead pattern (Chris Wilson's "A Tale of Two Clocks") — a timer that looks ~100 ms ahead and schedules events against `AudioContext.currentTime`. **Never** time notes with raw `setTimeout`. Tone.js `Transport` implements this; starting on it is fine, but keep it behind an interface.
- **Autoplay policy:** browsers require the `AudioContext` to be resumed from a user gesture. Bake a "click to start" into the UX; don't fight it.
- **Samples:** the engine loads project-relative samples through the sidecar asset endpoint, not direct filesystem paths. Cache by content hash so replacing `samples/kick.wav` invalidates correctly.
- **Custom DSP:** `AudioWorkletProcessor` on the audio thread; load Rust→WASM into the worklet for synthesis-heavy voices. If mixing Tone with custom worklets, bundle all custom processors into one AudioWorklet module and register multiple processor classes from that module. If this becomes awkward, run custom DSP in a separate context or move away from Tone for that layer.
- **The "almost right" failure mode:** DSP and scheduler code from an LLM often compiles and sounds *nearly* correct, then glitches under load or drifts. Review these like a domain expert; don't trust them on first pass.

## 15. Local-first now, deployable later

The fork in the road is how the browser reaches the filesystem. Three options:

- **(a) File System Access API** — pure browser, no install, but Chromium-only and watch is poll-based. Weakest watch story.
- **(b) Thin local sidecar** *(recommended)* — robust watch, works in any browser, can safely serve project-local sample assets, and its WebSocket/HTTP protocol **is the same shape as the eventual server API** (swap local fs for server storage and the browser barely changes). The agent-edits-files flow works perfectly because the sidecar is the fs authority.
- **(c) Tauri from day one** — Rust backend gives real fs + watch; natural given your background; means desktop is mostly already done. Reasonable to pick first instead of (b); the only cost is leaving pure-web until later.

Recommendation: **(b)** for v1 (keeps web-first, generalises cleanly to server), with **(c)** as the desktop step. Start the sidecar in Node to share the TypeScript format package and move to Rust/Tauri only when the product shape is proven.

**Evolution to deployed:** the document stays a portable bundle, so "stored on a server" is a storage + auth change, not a redesign. The in-app AI assistant (user supplies their own API token, app calls a model to edit the document) reuses the *same* apply-patch primitive — the model is just another editor emitting changes to the same format. **Do not build two AI paths.** Later, expose the document primitive over **MCP** so external agents get a clean tool surface — but it's the same underlying edits.

## 16. Phasing & acceptance criteria

**Phase 0 — Format & validator foundation** *(no UI, no audio)*
TypeScript workspace, schema, canonical parser/serializer, the v1 pattern-string grammar + parser, engine parameter registry, `validate`/`fmt`/`describe`/`doctor` CLI, the §8 worked example as a fixture, tiny test `.wav` samples, invalid fixtures, `format-spec.md`, `AGENTS.md`. `render` may exist as a documented stub, but it is not implemented in Phase 0.
✅ *Done when:* an agent hand-edits a project and it validates; parse→serialize is **idempotent** (round-trip stable); `fmt` output is byte-stable including canonical `steps` strings; invalid fixtures fail with useful diagnostics; all persisted musical time is integer ticks; per-step grid expression and automation-param validation are covered by fixtures.

**Phase 1 — Audio engine MVP**
Spike offline render path first, then load document → play. Lookahead scheduler, immutable scheduling snapshots, one synth + a drum sampler, sidecar sample loading, transport (headless or trivial UI). `render` CLI works through the chosen render path.
✅ *Done when:* the fixture plays back correctly and renders to a `.wav`; the render path is documented; replacing a sample file changes playback/render after cache invalidation.

**Phase 2 — Web UI (read + edit)**
Step sequencer + piano roll + transport, rendered from the document. Editing mutates the model and writes files via the sidecar.
✅ *Done when:* editing in the UI updates the file; opening a file shows it correctly.

**Phase 3 — Two-way live sync**
Sidecar watcher, authenticated local protocol, Host/Origin checks, write batches, atomic per-file writes, content-hash/write-ID echo detection, file-granular external-edit reconcile, debounced writes.
✅ *Done when:* Claude Code edits a track file and the UI updates live **without reload**; a UI edit produces a **clean, minimal diff**; watcher race tests cover own-write echoes, external edits, delete/recreate, invalid intermediate files, and multi-file write batches.

**Phase 4 — Expressive UI/audio + DSP**
Full UI/audio support for automation lanes, per-note/grid expression (velocity, micro-timing, gate, probability, ratchets), swing/groove, mixer + effects, first Rust→WASM custom synth.
✅ *Done when:* the Phase 0 expression model is editable and audible; a groove with swing + automation sounds musical, not quantised; the WASM voice runs in the worklet.

**Phase 5 — Desktop & deploy** *(later)*
Tauri wrap → server storage + auth → in-app assistant (user token) → MCP server over the document primitive.

## 17. Repository layout

```
/packages/format      schema, canonical parser/serializer, pattern grammar, semantic validation
/packages/cli         musictool CLI using /packages/format
/packages/engine      audio engine boundary, scheduler, synth/sampler adapters, worklets
/app                  React + Vite web UI
/sidecar              local fs bridge, watcher, authenticated WebSocket/HTTP, sample assets
/crates               Rust DSP / WASM / future Tauri backend (create when Phase 4/5 needs it)
/fixtures/valid       example projects, including the §8 worked example
/fixtures/invalid     broken projects used to test diagnostics
/docs                 format-spec.md, AGENTS.md, this PLAN.md
```

## 18. Risk register & division of labour

- **The format is hardest to change.** Stabilise Phase 0 before building on it. Changing the schema after the UI and engine bind to it is expensive.
- **Mixed timing units are fatal.** Persist ticks everywhere. Beat/bar floats may appear in UI labels, never in canonical project files.
- **Pattern strings must stay deterministic.** `steps` is placement-only; expression lives in sorted `stepEvents`; `fmt` owns spacing and case.
- **Parameter validation is part of the music model.** Engine params and automation params must be checked against the registry, or agents will silently create broken automation.
- **Split canonical implementations create invisible divergence.** Keep Phase 0 parser/formatter/validator in one TypeScript package reused by CLI, UI, sidecar, and tests.
- **Schema tooling can lie by omission.** Test Ajv 2020-12 mode and any TS type generator against the actual schema features before trusting them.
- **Scheduler & DSP correctness** — the "almost right" trap. *Human owns / closely reviews.* Agent does breadth (UI, plumbing, CRUD, sidecar protocol).
- **Sync reconcile & echo detection** — subtle concurrency; infinite-loop and lost-edit bugs live here. *Human owns.*
- **External edits are not local undo.** Treat accepted external changes as a new baseline unless a later collaboration model deliberately changes that policy.
- **Sidecar security** — localhost filesystem tools are attack surfaces. Token auth, Host/Origin checks, path confinement, message limits, and atomic writes are not optional.
- **Offline render uncertainty** — Tone offline rendering exists, but the exact headless path must be proven with samples and transport before tests depend on it.
- **Don't let agent-legibility distort the musical model** — keep ticks, swing, micro-timing first-class even though they make the schema less tidy.
- **Sample portability** — always project-relative paths; never absolute (the REAPER mistake).
- **Tone/worklet integration** — plan worklet registration before mixing Tone with custom DSP; bundle custom processors into one module.
- **Fixture drift** — the worked example is a contract. Keep valid fixtures complete and invalid fixtures intentionally broken.

---

## 19. First actions for the agent

1. Scaffold the TypeScript monorepo (§17) with package workspaces; set up lint/test/CI. Do not add Rust workspace scaffolding until Phase 4/5 work actually needs it.
2. Write `docs/format-spec.md` from Part One; create `AGENTS.md`.
3. Implement the JSON Schema Draft 2020-12 schemas for `project / track / pattern / instrument / arrangement` and validate the TS type-generation path against tuples and closed objects.
4. Build the canonical parser/serializer in `/packages/format`: JSON5 read, duplicate-key rejection, canonical readable JSON write, path/id validation helpers, integer timeline normalisation, canonical `steps` formatting.
5. Implement the v1 pattern-string grammar + parser with location-aware errors and sparse `stepEvents` expression validation.
6. Implement `validate`, `fmt`, `describe`, and `doctor`; add the §8 worked example under `/fixtures/valid` with tiny test `.wav` samples.
7. Add the built-in engine parameter registry and validate instrument params plus automation target params.
8. Add invalid fixtures for bad IDs, absolute sample paths, `..` paths, wrong step counts, non-integer timeline values, missing references, unknown fields, malformed pattern strings, bad `stepEvents`, bad engine params, non-automatable params, and unsupported mixed pattern representations.
9. Write round-trip tests: **parse → serialize → parse must be identical**, and `fmt` must be byte-stable.
10. Write golden-output tests for `describe` and diagnostics tests for `doctor`.

Stop at the end of Phase 0 and have a human confirm the format feels right before building the engine and UI on top of it — that review is the cheapest it will ever be.

---

## 20. External technical context checked

These are not dependencies to blindly copy; they are context anchors for future agents.

- **RFC 8785 / JSON Canonicalization Scheme:** useful model for deterministic JSON, I-JSON constraints, stable primitive serialisation, and property ordering. This project uses a readable canonical JSON variant instead of raw compact JCS.
- **JSON Schema Draft 2020-12:** current schema baseline for tuple validation (`prefixItems`), composed closed objects (`unevaluatedProperties`), and modern validators such as Ajv 2020.
- **Strudel mini-notation:** validates the premise that compact musical text is agent-friendly, but its cycle-relative timing is intentionally not copied into this bar/beat/tick sequencer.
- **Web Audio / AudioWorklet:** custom low-latency DSP belongs in AudioWorklet; WASM can run there for heavier processors.
- **Tone.js offline rendering:** `Tone.Offline` exists and is useful, but sample-heavy headless rendering must be spiked before it becomes the only regression path.
- **Browser autoplay policy:** the app must create or resume `AudioContext` from a user gesture.
- **File System Access API:** useful for pure-browser read/write, but not enough for robust agent-edits-files live watching; the sidecar remains the v1 path.
- **WebSocket local security:** localhost filesystem bridges still require token auth, Host/Origin checks, path confinement, message limits, and avoiding token leakage in URLs.
