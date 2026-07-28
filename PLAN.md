# Agent-native electronic music tool — design & implementation plan

> Status: design spec, ready for an agent to begin Phase 0.
> Audience: an AI coding agent (Fable-class, e.g. Claude Code) plus a human maintainer. The human provides musical direction by listening to renders and steering the product; the human does **not** review implementation code. Every property that matters must therefore be enforced by tests, not by review (§18).
> Phase 0 creates `docs/format-spec.md` and `AGENTS.md`. After that, agents must read those files before editing project bundles.

---

## 1. The one-sentence thesis

A web-based electronic music tool whose **source of truth is a human- and agent-readable project document on disk**, where the graphical UI and an AI agent are *two equal editors* of that same document, kept in sync live.

A human composes in the UI. An agent (Claude Code, or later an in-app assistant) edits the same files. Neither is privileged; the document is. This is the single decision everything else hangs off, so it is specified first and in the most detail.

The second load-bearing decision follows from the first: **the agent must be able to check its work end to end without a human.** Validation alone only proves the JSON is well-formed; it cannot prove the hi-hats groove. The agent's real loop is *edit → validate → render → analyze*, so a deterministic offline renderer with machine-readable audio analysis is core infrastructure, built immediately after the format itself (§13, §14, §16).

---

## 2. What we learned from prior art (and why this shape is right)

Three lineages were examined:

1. **MCP-into-DAW** (AbletonMCP, reaper-mcp): an agent drives a running DAW's API by remote control. Powerful, but the DAW's in-memory session is the truth and the agent pokes at it through a narrow RPC surface. There is no durable, diffable artifact the agent reasons over. We are deliberately *not* doing this.
2. **Live-coding** (Sonic Pi, TidalCycles, **Strudel**): music *is* text. Strudel's "mini-notation" (`"bd*4"`, `"a b [c d]"`, Euclidean `"(3,8)"`) is the best existing proof that rhythm and melody compress into short, legible strings an LLM handles well. We borrow its density for *patterns* but reject its cycle-relative timing model (confusing next to a bar/beat UI).
3. **Symbolic-music LLM work** (ComposerX, CoComposer): repeatedly uses **ABC notation** / **LilyPond** as interchange precisely because they are text an LLM can emit directly. Validates "text source of truth," but these are *score* notations (staves, classical) and a poor fit for grids, drum samples, synth parameters, and automation.

**Conclusion:** the agent-native, file-as-truth approach is genuinely under-explored versus the MCP-bolt-on approach, and is better aligned with the goal. We invent a small bespoke format, but steal the good ideas: Strudel's pattern density, REAPER's proof that a plain-text project format survives for decades — and REAPER's portability mistake (absolute sample paths that break when a project moves) which we avoid by keeping everything project-relative.

---

# Part one — the interface (the what)

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

A critical consequence for the agent integration: **for local use there is no agent-specific code at all.** The agent just edits files with its normal tools; a file watcher notices and updates the UI. We build a good format, a good watcher, and a good render/analyze loop — not an "agent mode."

## 4. Project layout: a directory, not a single file

A project is a *bundle* (a directory), not one monolithic file:

```
my-track/
  project.json          # global meta: tempo map, meter map, key, swing, track order
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
  automation/
    pad.json             # one file per automated track (see §8)
  arrangement.json       # timeline: which pattern plays where
  samples/               # project-relative audio (NEVER absolute paths)
    kick.wav
    hat.wav
```

Why a directory:
- **Surgical edits.** An agent changing the hi-hats touches only `patterns/drums-verse.json`.
- **Clean diffs / git-native.** "Agent changed the hat pattern on bars 5–8" is a small, legible change, not noise in a 5,000-line blob.
- **Fewer collisions.** UI and agent rarely touch the same file at the same instant.
- **Portability.** Samples live inside the bundle, referenced relatively, so moving/zipping the folder never breaks (the REAPER lesson).

Automation follows the same philosophy: it is per-track data that grows large, so it lives in `automation/<track>.json` rather than inside `arrangement.json`, keeping arrangement diffs clean and automation edits collision-free.

Provide a **single-file export** (`my-track.zip` or a flattened `.json`) for sharing/portability, but the directory is the working format.

Reference and path rules:
- IDs are lowercase kebab-case ASCII: `^[a-z][a-z0-9-]*$`.
- File names should match object IDs (`patterns/bass-main.json` contains `"id": "bass-main"`; `automation/pad.json` contains `"track": "pad"`).
- Project-relative paths must never be absolute and must never contain `..`.
- Unknown JSON fields are validation errors unless the schema explicitly marks an extension point.
- Orphan files are warnings in early development and errors once migration/versioning exists.

Sample rules:
- Samples live under `samples/` and are referenced by project-relative path; absolute paths and `..` are errors (the REAPER lesson).
- v1 accepts uncompressed PCM WAV (`.wav`) only; other formats are deferred. Validate by extension *and* a basic header check, not by trust.
- A referenced sample that does not exist on disk is an error that names the missing path.
- A per-sample size cap is enforced (v1 default 50 MB, configurable) to keep bundles and the asset endpoint sane; oversize is an error.

## 5. Format choice (decided, with the alternatives on record)

**Container: strict JSON, governed by a published JSON Schema.**
- Reading is **strict**: RFC 8259 JSON only, duplicate keys rejected. No JSON5, no comments, no trailing commas. Modern agents emit strict JSON reliably; tolerating a looser dialect buys nothing and creates a class of round-trip and canonicalisation edge cases.
- A comment (`//` or `/* */`) encountered on read is a **parse error with a helpful diagnostic**: "comments are not valid JSON; put durable annotations in a `description` or `notes` field." Annotations are first-class structured fields, never syntax trivia, so the canonical serializer never has to preserve anything it can't represent.
- Writing is **canonical readable JSON**: UTF-8, deterministic key order, 2-space indent, trailing newline, normalised number formatting, and no non-finite numbers. A `fmt` command (think `prettier`/`rustfmt`) makes every writer converge on identical bytes → clean diffs.

Canonicalisation is **JCS-inspired, not raw RFC 8785 JCS**. RFC 8785 is useful because it defines deterministic JSON by constraining JSON to an interoperable subset and using stable primitive serialisation + property ordering. This product deliberately keeps pretty 2-space output and may use schema-specific key order for readability. Hashes must therefore use `musictool fmt` output, not a generic JSON library's output.

Use **JSON Schema Draft 2020-12** for schemas. Prefer closed objects (`unevaluatedProperties: false`) once extension points are deliberately modelled, use `prefixItems` for tuple-shaped arrays such as `[tick, value]`, and keep semantic validation in code where JSON Schema is the wrong tool. If using Ajv, use the 2020-12 entry point (`ajv/dist/2020`) and add a test that proves `prefixItems` and `unevaluatedProperties` are actually enforced.

**Patterns inside the JSON use compact strings, not deep nesting.** A drum lane is a string, not 16 objects:

```json
{ "lane": "kick",  "steps": "x..x ..x. x..x ..x." }
```

These strings have their own small grammar (Strudel-inspired) with a dedicated parser + validator. Keep the grammar **bar/tick-absolute**, not cycle-relative — a UI sequencer thinks in bars/beats/steps, and Tidal's "events fill a cycle" model is powerful but confusing next to a piano roll.

**Why JSON Schema specifically:** it is *one shared contract* used by (a) the `validate` CLI, (b) the agent (hand it the schema and it edits correctly), and (c) the UI's type bindings (generate TS types from the schema). Universal parsers in every language. The usual JSON complaints (verbosity, no comments, noisy reformatting) are neutralised by canonical formatting + structured annotation fields + compact pattern strings.

**Canonical implementation choice for Phase 0:** implement parser, formatter, validator, pattern parser, and CLI in one TypeScript workspace package (`/packages/format`) and reuse that exact package in the UI. Do **not** maintain separate Rust and TypeScript canonical serializers in v1. Rust can enter later for DSP, sidecar, Tauri, or a future WASM-backed format core if there is a measured need.

Type generation is useful but not magic. Validate the chosen JSON-Schema-to-TypeScript generator against the real schemas in Phase 0, especially tuple arrays (`prefixItems`) and closed composed objects (`unevaluatedProperties`). If the generator cannot represent the schema accurately, hand-write the public domain types and test them against schema fixtures instead of weakening the schema.

Versioning and migrations:
- `project.json` contains `"format": 1`.
- `musictool validate` rejects projects with a newer unknown format.
- `musictool migrate <project>` is not required in Phase 0, but the schema should reserve enough structure for it. Do not silently migrate on open.
- Breaking schema changes increment `format`. Non-breaking additive changes must still preserve deterministic formatting.
- Golden fixtures must include the current version number so accidental schema drift is visible in diffs.

Engine parameter registry:
- Engine-specific params are not arbitrary open JSON. Each built-in engine (`basic-mono`, `basic-poly`, `drumkit`) must declare a parameter registry with valid names, value type, min/max or enum, default, units, and whether it is automatable. The concrete v1 registry contents are specified in §6.2. Because all params are integers (§6), comparison is exact equality; the registry reserves an optional `epsilon` field only for a hypothetical future float param.
- Instrument `params` use the registry to validate flat dotted keys such as `"filter.cutoff"`.
- Automation `param` values must reference an automatable registry entry on the target track's instrument.
- Unknown params are validation errors with "did you mean" diagnostics where possible (`fitler.cutoff` should not silently pass).
- Third-party engines later need a plugin registry or explicit extension mechanism; do not weaken built-in validation to prepare for them prematurely.

**Alternatives considered and rejected:**
- **TOML** — reads beautifully for config, but arrays-of-tables get ugly for hundreds of events; no universal schema story.
- **JSON5 read tolerance** — originally planned; dropped. Agents don't need it, and it drags in a format-preservation problem (comments destroyed on rewrite) that strict JSON simply doesn't have.
- **Bespoke DSL** (full mini-notation document) — maximally compact, but you maintain a parser *and* face hard lossless round-tripping when the UI rewrites it.
- **ABC / LilyPond / MusicXML** — score-oriented; wrong primitives for grids, samples, synth params, automation.

## 6. The musical requirements drive the schema (do not let "agent-legible" distort it)

The most common failure when designing a tidy text schema is under-modelling timing and expression, then discovering it only when something sounds robotic. Bake these in from the start:

- **Timing resolution: integer ticks, not floats and not just grid steps.** Use PPQN (e.g. 960 ticks per quarter note). A note has an absolute `startTick` and `durationTicks`. Automation points, clip positions, pattern lengths, offsets, and micro-timing are all ticks. A 16th-step grid is a *view*, not the storage model. This is what lets swing, groove, and micro-timing exist at all.
- **Per-note expression:** velocity, micro-timing offset (± ticks), gate length, probability, and ratchet/repeat count.
- **Swing:** a project-level default with per-lane override (see below).
- **Automation:** parameter lanes (filter cutoff, volume, send, any synth param) as breakpoint curves over time, with interpolation type.
- **Key/scale (optional):** enables scale-aware agent edits and UI snapping.

Persisted musical time uses these conventions:
- `ppqn` lives in `project.json` and is fixed for the project. Do not change it after project creation unless a migration rewrites every tick value.
- `ticksPerBar = ppqn * 4 * timeSignature[0] / timeSignature[1]`. With 960 PPQN and 4/4, one bar is 3840 ticks.
- Pattern-local events use ticks from the start of the pattern.
- Arrangement clips use ticks from the start of the song.
- UI labels may show bars/beats/steps, but files store ticks.
- Timeline fields use JSON Schema `integer` plus semantic validation and `fmt` normalisation. Inputs like `3840.0` may parse to a number, but canonical output must write `3840`.
- **Canonical files contain no floating-point numbers at all.** Every persisted quantity — timeline positions *and* musical parameters — is an integer in a defined unit. Velocity, probability, sustain, resonance, and pan are permille (0–1000, or ±1000); envelope times are milliseconds; cutoff is hertz; detune and pitch are cents; gain is dB×100; tempo is bpm×100. The exact units per parameter live in the registry (§6.2). This makes byte-identical output across languages reduce to integer printing (no Grisu/Ryū shortest-round-trip dependency) and makes semantic comparison exact integer equality (no epsilon needed). The chosen resolutions (1 ms, 1 Hz, 0.1% of full scale, 1 cent, 0.01 dB, 0.01 BPM) are below the threshold of musical relevance for v1. Inputs like `3840.0` or `0.80` may parse to a number, but canonical output must write the integer (`3840`, and `0.8`-as-permille is `800`). If a genuinely continuous float parameter is ever required, it may not be added until it ships with a defined canonical decimal precision and a cross-implementation byte-identical test (§18).

Tempo and meter:
- `project.json` has `tempoMap` and `meterMap`, each starting at tick 0, and these are the **only** tempo/meter fields — there are no duplicate convenience fields to keep in sync (a redundant field is an invariant to enforce and a place for an editor to make exactly the mistake this format exists to prevent).
- Tempo points store `bpm` in **bpm×100** (124 BPM → `12400`), so non-integer tempos like 128.5 BPM (`12850`) are representable without violating the no-floats rule. This unit is fixed now because changing it later is a format migration.
- V1 supports a single effective tempo and meter: validators require exactly one point in each map, at tick 0. The map *shape* is reserved now because tick→seconds conversion depends on it; later tempo ramps add `interp` to tempo points, and meter changes remain step changes.
- Renderers and schedulers must read the map shape even though v1 only contains one point.

Swing:
- `project.json.swing` is a permille integer (0–1000) applied to all grid lanes; a lane may override it with `defaults.swing`. It is **required, not defaulted** — a project-wide timing law is written rather than inferred, so straight time says `"swing": 0`. (This line previously said "default 0", which the schema contradicts; `docs/format-spec.md` §1.1 is the inventory.)
- Semantics: every odd-indexed grid step in a lane is delayed by `round(swing * stepTicks / 2000)` ticks, where `stepTicks` is the lane's step duration in ticks. 0 is straight, ~667 approximates triplet swing, 1000 delays the off-step halfway to the next step. Swing is applied before `microTicks`.
- Swing is not a per-step property; per-step timing nudges are what `microTicks` is for.

If the schema can't represent swing and micro-timing, the output will sound quantised and lifeless no matter how good the synths are. If the schema mixes tick integers with beat floats, the agent will make subtle alignment mistakes. Avoid that from day one.

### 6.1 Pattern-string grammar v1

Pattern strings are compact **grid views** over the tick model. They must parse into deterministic tick events.

For v1, keep the grammar intentionally small and **placement-only**:
- `x` = trigger at this grid step.
- `.` = rest at this grid step.
- Spaces are visual separators only and do not count as steps.
- `|` is an optional bar separator. It must fall on a bar boundary if present.
- `X` (accented trigger) is **rejected in Phase 0**. The validator emits a diagnostic pointing at the offending column: "accented triggers are not supported yet; use lowercase `x` and set `velocity` in `stepEvents`." It is neither silently accepted nor silently converted. The auto-convert-to-`stepEvents` behaviour is deferred until the basic grammar has golden tests.
- `-` (tie/hold marker) is reserved for future melodic grids and is **rejected** in drum lanes until implemented, with a diagnostic naming the column.

Every lane with `steps` must declare a grid:

```json
{
  "lane": "kick",
  "grid": { "stepsPerBar": 16 },
  "steps": "x..x ..x. x..x ..x.",
  "defaults": { "velocity": 800 },
  "stepEvents": [
    { "step": 6, "velocity": 550, "probability": 800 },
    { "step": 11, "microTicks": -12, "ratchet": 2, "gateTicks": 120 }
  ]
}
```

This split is deliberate:
- `steps` says **where hits exist**.
- `defaults` supplies lane-level expression for all hits (velocity, gate, probability, and the lane's `swing` override per §6).
- `stepEvents` supplies sparse per-step expression overrides.
- Rich expression does not require a second event-list representation, and the string stays easy for agents to edit.

Validation rules:
- Count only non-space, non-`|` symbols as steps.
- Required step count is `stepsPerBar * patternBars`, where `patternBars = lengthTicks / ticksPerBar`.
- `lengthTicks` must be an integer multiple of a bar for v1 grid patterns.
- Each grid step maps to `stepIndex * ticksPerBar / stepsPerBar` within its bar. This must be an integer; reject grids that do not divide cleanly into ticks.
- `stepEvents[*].step` is zero-based within the pattern, must point at an `x` step, and must be unique.
- `microTicks` is applied after swing. `ratchet` is a positive integer count. `gateTicks` is a positive integer duration override. `velocity` and `probability` are permille integers (0–1000); see §6.2.
- Advanced Strudel-like features (`*`, Euclidean `(3,8)`, nested groups, random choice, probability syntax) are explicitly out of v1. Add them only after the basic grammar has golden tests.

Canonical pattern formatting:
- `fmt` emits `steps` as the canonical placement string of `x` and `.` only. (`X` is rejected on read in v1, so there is no case-folding to perform.)
- Within each bar, group steps in blocks of four when `stepsPerBar` is divisible by four. Use ` | ` between bars. Example for one 16-step bar: `"x..x ..x. x..x ..x."`.
- If `stepsPerBar` is not divisible by four, group by the largest divisor of `stepsPerBar` that is `<= 4` and `> 1`; if no such divisor exists, emit the bar with no internal spaces.
- Do not preserve arbitrary spacing from input; `fmt` owns spacing.
- Sort `stepEvents` by `step`, then canonical key order. Do not emit empty `stepEvents`.

Pattern representation rules:
- A pattern is either `kind: "grid"` with `lanes`, or `kind: "notes"` with `notes`. Do not allow both in v1.
- Drum tracks use grid patterns in v1.
- Melodic tracks use note event-list patterns in v1.
- Melodic grid patterns and ties are future work and must not be accepted until their canonical form is specified.

### 6.2 Engine parameter registry (v1 contents)

*The same tables now live in `docs/format-spec.md` §6, which is what implementers and agents read — a spec that defers its parameter table to a plan document leaves an agent unable to set any parameter. The registry in `packages/format/src/registry.ts` is the implementation, and a test (`packages/format/test/registryDocs.test.ts`) asserts that both documents' tables match it exactly, so the three cannot drift. Change the registry first, then let the failing test tell you which tables to update.*

All persisted quantities are integers in a defined unit (§6). Each built-in engine declares a registry; `validate` checks instrument `params` and automation targets against it, and unknown keys are errors with "did you mean" suggestions.

Units:
- `Hz` — integer hertz.
- `ms` — integer milliseconds.
- `cents` — integer cents (100 = one semitone).
- `permille` — integer 0–1000 (or ±1000 for bipolar) representing a 0.0–1.0 normalised value (velocity, sustain level, resonance, probability, swing, pan).
- `dB×100` — integer hundredths of a decibel (−6 dB → −600).
- `bpm×100` — integer hundredths of a BPM (128.5 BPM → 12850). Used only in `tempoMap`.
- `count` — a plain non-negative integer.
- `enum` — a string from a fixed set.

Shared subtractive-voice params (both `basic-mono` and `basic-poly`):

| param | unit | range / values | default | automatable |
|---|---|---|---|---|
| `oscillator` | enum | sine, triangle, sawtooth, square | sawtooth | no |
| `detune` | cents | −1200..1200 | 0 | yes |
| `filter.type` | enum | lowpass, highpass, bandpass | lowpass | no |
| `filter.cutoff` | Hz | 20..20000 | 12000 | yes |
| `filter.resonance` | permille | 0..1000 | 100 | yes |
| `filterEnv.amount` | permille | 0..1000 | 0 | yes |
| `amp.attack` | ms | 0..20000 | 5 | no |
| `amp.decay` | ms | 0..20000 | 100 | no |
| `amp.sustain` | permille | 0..1000 | 900 | no |
| `amp.release` | ms | 0..60000 | 1000 | no |
| `gain` | dB×100 | −6000..600 | 0 | yes |
| `pan` | permille | −1000..1000 | 0 | yes |

`basic-mono` adds:

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `portamento` | ms | 0..5000 | 0 | no |

`basic-poly` adds:

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `maxVoices` | count | 1..32 | 16 | no |

`drumkit` params are per kit voice, namespaced `<voice>.<param>` where `<voice>` is a key in the instrument's `kit` map (e.g. `kick.gain`):

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `<voice>.gain` | dB×100 | −6000..600 | 0 | yes |
| `<voice>.pan` | permille | −1000..1000 | 0 | yes |
| `<voice>.pitch` | cents | −2400..2400 | 0 | no |
| `<voice>.chokeGroup` | count | 0..16 | 0 (none) | no |

Track effects (`format` 2 and newer; see §16 Phase 5). A track's `effects` chain is applied in array order after its instrument, and each effect carries its own `id` so automation addresses `fx.<id>.<param>` — three segments, so it cannot collide with a drumkit's two-segment `<voice>.<param>`, and reordering the chain re-targets nothing.

**delay**

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `time` | ms | 1..2000 | 375 | no |
| `feedback` | permille | 0..950 | 300 | yes |
| `damping` | permille | 0..1000 | 300 | yes |
| `mix` | permille | 0..1000 | 250 | yes |

`time` is ms rather than a musical division because every *position* here is ticks while device time constants are already ms (`amp.attack`, `portamento`), and a synced value would be unautomatable by construction and would make the line length a function of tempo — a real problem once tempo ramps arrive, since a moving tap needs a fractional read pointer. It is non-automatable because the tap is an integer offset: sweeping it would step, not glide. `feedback` stops at 950 because unity never decays, and the bound lives in the declared range rather than in a runtime clamp nobody can see.

**reverb**

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `size` | permille | 0..1000 | 500 | yes |
| `damping` | permille | 0..1000 | 500 | yes |
| `width` | permille | 0..1000 | 1000 | yes |
| `mix` | permille | 0..1000 | 200 | yes |

`size` maps to a comb recirculation gain strictly below 1, so stability is a property of the mapping rather than of a limiter. The structure is multiplies and adds only — no transcendentals — which matters because §18 records that JS trig is implementation-defined.

**filter**

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `mode` | enum | lowpass, highpass, bandpass | lowpass | no |
| `cutoff` | Hz | 20..20000 | 1000 | yes |
| `resonance` | permille | 0..1000 | 100 | yes |

The same biquad and Q mapping the synth voices use, so a track sweep and an instrument sweep cannot sound like two different filters. Named `mode` because an effect already has a `type`.

Registry rules:
- `automatable: yes` is required for an automation lane to target a param; automation values use the param's unit (a `filter.cutoff` lane stores integer Hz).
- Per-note / per-step expression fields reuse these units: `velocity` and `probability` are permille; `microTicks` and `gateTicks` are ticks; `ratchet` is a count. Swing is a project/lane-level permille setting (§6), not per-step expression.
- A `drumkit` automation target must name an existing voice (`kick.gain`, not `kik.gain`), validated against the instrument's `kit` map.
- Third-party engines later need a plugin registry; do not weaken built-in validation to prepare for them.

### 6.3 Headroom is the author's job, not the engine's

*Added after building the Phase 1 renderer, which revealed this by clipping the worked example.*

`gain` defaults to 0 dB (unity), and a resonant filter can output a higher peak than it was fed —
that is what resonance does. So a single sawtooth voice at velocity 900 through `filter.resonance:
200` peaks around 1.33, and summing it with drums pushes the master to roughly +3.6 dBFS. Nothing
is malfunctioning; there is simply no headroom anywhere in the default signal path.

The decision: **the engine never applies hidden gain reduction.** Automatic makeup gain or a
built-in limiter would make levels unpredictable and un-reasonable-about, which is exactly wrong for
a format whose whole premise is that an agent can predict the effect of an edit. Instead:

- Authors (human or agent) gain-stage explicitly with `gain`, and the worked example demonstrates
  this (§8: the bass sits at −1000, i.e. −10 dB).
- The renderer leaves the float master unclipped so `render --analyze` can *measure* the overshoot;
  only integer WAV quantisation clamps.
- `--analyze` reports master clipping as a warning, so an author who overshoots is told, with a
  number, rather than discovering it by ear.

This is the general principle for the whole engine: surface problems as measurements, never
silently paper over them.

## 7. Separate the *musical document* from *engine state*

Only the musical document persists to disk:

| Persists to file (document) | Runtime only (engine state) |
|---|---|
| tempoMap, meterMap, key, swing | playhead position |
| tracks, instruments, patterns | audio buffers, voice allocation |
| arrangement / timeline | undo/redo stack |
| automation, per-note expression | current selection |
| mixer levels and effect chains (built) | live solo/mute (debatable — may persist) |

Keeping this boundary clean is what keeps the agent integration sane: the agent edits the document, never the engine.

## 8. Worked example (the thing to pressure-test first)

`project.json`:
```json
{
  "format": 1,
  "name": "first track",
  "ppqn": 960,
  "tempoMap": [
    { "startTick": 0, "bpm": 12400 }
  ],
  "meterMap": [
    { "startTick": 0, "timeSignature": [4, 4] }
  ],
  "key": { "root": "A", "scale": "minor" },
  "swing": 0,
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
    "filter.cutoff": 800,
    "filter.resonance": 200,
    "gain": -1000,
    "oscillator": "sawtooth"
  }
}
```

(`params` keys are shown in canonical order — `fmt` sorts them alphabetically, since `params` is an
open map rather than a fixed-shape object. The `gain: -1000` is −10 dB; see §6.3 for why it is
there.)

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
    "amp.attack": 400,
    "amp.release": 1200
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
      "defaults": { "velocity": 600, "swing": 120 },
      "stepEvents": [
        { "step": 2, "velocity": 350, "probability": 800 },
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
    { "pitch": "A1", "startTick": 0,    "durationTicks": 720, "velocity": 900 },
    { "pitch": "A1", "startTick": 960,  "durationTicks": 480, "velocity": 700, "microTicks": -8 },
    { "pitch": "C2", "startTick": 2400, "durationTicks": 960, "velocity": 800, "probability": 800 }
  ]
}
```

`arrangement.json` (timeline — clips only; automation lives per-track under `automation/`):
```json
{
  "lengthTicks": 61440,
  "clips": [
    { "track": "drums", "pattern": "drums-verse", "startTick": 0,     "repeatCount": 16 },
    { "track": "bass",  "pattern": "bass-main",   "startTick": 15360, "repeatCount": 6 }
  ]
}
```

`automation/pad.json`:
```json
{
  "track": "pad",
  "lanes": [
    {
      "param": "filter.cutoff",
      "interp": "linear",
      "points": [ [0, 200], [30720, 4000], [61440, 800] ]
    }
  ]
}
```

The first real task (Phase 0) is to build *exactly this example*, write the schema that validates it, and prove parse→serialize is idempotent. If an implementation cannot validate this fixture and reject deliberately broken variants of it, Phase 0 is not done.

### 8.1 Semantic validation rules (v1 checklist)

JSON Schema covers shape; these cross-file/semantic rules live in code. Each must have a passing valid fixture and a failing invalid fixture:

- Every `id` matches `^[a-z][a-z0-9-]*$` and equals its file name (for automation files, the `track` field equals the file name).
- `project.json.trackOrder`: every listed id has a `tracks/<id>.json` (unknown id → error), there are no duplicate ids (→ error), and a track file missing from `trackOrder` is an orphan (warning early, error once versioning exists, per §4).
- Every `track.instrument` references an existing `instruments/<id>.json`.
- Every `track.patterns[*]`, every `arrangement.clips[*].pattern`, and every `clips[*].track` resolves to an existing object.
- A grid (drum) track references only `kind: "grid"` patterns; a melodic/instrument track references only `kind: "notes"` patterns.
- `ppqn`, `tempoMap`, `meterMap` obey §6: exactly one point each in v1, both starting at tick 0; `bpm` is bpm×100 and in a sane range (e.g. 2000–30000).
- Grid `lengthTicks` is a positive integer multiple of a bar; step counts and step→tick divisibility obey §6.1.
- Instrument `params` keys exist in the engine's registry (§6.2), values are in range/enum, and unknown keys produce "did you mean" suggestions.
- Every `automation/<track>.json` names an existing track; each lane's `param` targets an `automatable: true` registry entry on that track's instrument (including the `<voice>.<param>` form for drumkits); at most one lane per param per track; `points` values are in the param's unit and range; point ticks are strictly increasing and within `arrangement.lengthTicks`.
- Every referenced sample resolves to a file inside `samples/`, is project-relative, contains no `..`, and obeys the §4 sample rules (WAV, exists, within size cap).
- No persisted number anywhere is a float; all quantities are integers in their declared unit (§6).
- `project.json.format` equals the supported version; a newer `format` is rejected (not migrated).

## 9. The agent contract

Give the agent a fast feedback loop and a written contract. Ship in-repo:

- `docs/format-spec.md` — the format, with examples (this section, expanded).
- `AGENTS.md` — how to edit a project safely, how to validate, how to render and read the analysis output, common mistakes.
- A CLI (see §13) the agent runs to **verify its own edits** without a human or a browser.

Agents are dramatically more reliable with a verification loop, and for music the loop must reach the *sound*, not stop at the syntax. The full loop is:

1. `validate` — is the document well-formed and semantically coherent?
2. `describe` — does the project contain what I think it contains?
3. `render --analyze` (Phase 1) — does it *sound* like what I intended? Onsets where the kick should be, bass audible and in range, nothing silent, nothing clipping.

The agent cannot listen; the analysis output is its ears. The human listens to the rendered audio and gives musical direction; the agent iterates against the analysis until the human's direction is satisfied.

---

# Part two — implementation (the how)

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
- Generate a session token at sidecar startup and require it on every WebSocket/HTTP request. For browser WebSockets, prefer first-message authentication or `Sec-WebSocket-Protocol`; do not put the token in the URL query string.
  - **The token is a session handle, not a security control**, and this section originally overstated it. It is served to any unauthenticated local requester — a plain `curl http://127.0.0.1:PORT/app/` returns it, because the page needs it and a navigation cannot carry a header — so it cannot defend against a local process that can already reach the port. Verified: an unauthenticated GET yields the token and that token then reads a project snapshot. **What actually defends this server is the loopback bind plus the Host and Origin checks**, which do hold: the same token with a forged `Origin` is refused. Treat the token as identifying *which window holds the write session*, and keep the real defences in the checks that a browser cannot forge.
- Validate the `Host` header against the expected loopback host/port to reduce DNS rebinding risk.
- Validate the browser `Origin` header against the Vite/app origin in development and the packaged app origin in desktop builds. Treat Origin as one check, not the only check.
- Enforce project root confinement on every path: resolve, normalise, reject absolute paths, reject `..`, reject symlink escapes unless explicitly allowed later.
- Add message size limits and reject unknown protocol message types.
- Use atomic writes: write to a temp file inside the project, fsync where practical, then rename.
- Never expose a generic "read any file" or "write any file" RPC.

## 11. Tech stack (with rationale)

- **App:** TypeScript + **React** + **Vite**. React for the breadth of agent training data (the agent writes all of the UI); note Svelte is arguably a better fit for fine-grained audio-reactive state if you prefer — flagged, not chosen.
- **State:** a single document store (Zustand or similar) — lightweight, easy for an agent to reason about, no boilerplate.
- **Audio: one DSP core, used everywhere.** The synths and sampler are written once, in plain TypeScript, as pure sample-block processors with no Web Audio dependency (`/packages/engine`). The **offline renderer** runs that core directly in Node (faster than realtime, fully deterministic). The **live engine** runs the *same* core inside an `AudioWorkletProcessor` in the browser, fed by the same compiled event schedule. This guarantees live playback and rendered output are the same sound, makes all DSP testable headlessly, and avoids depending on any third-party engine's offline mode. Tone.js is deliberately **not** a core dependency (its transport/scheduling ideas are still good reference material); Rust→WASM can replace hot DSP paths inside the same worklet later without changing the architecture.
- **Event compilation is a shared pure function.** `compile(document) → sample-accurate event schedule` (notes, automation curves, swing, micro-timing, ratchets, probability resolution) lives in `/packages/engine` and is used by the offline renderer, the live scheduler, and tests. Almost all musical correctness lives in this pure, exhaustively testable layer; the live path adds only thin Web Audio plumbing.
- **Format package + CLI:** TypeScript first. This owns strict JSON read, canonical JSON write, JSON Schema validation, semantic validation, pattern parsing, `fmt`, `validate`, and `describe`; the CLI adds `render` on top of `/packages/engine`.
- **Sidecar:** Node first for speed and shared TypeScript types, with the protocol designed so a Rust/Tauri backend can replace it later. It exposes a small authenticated protocol: `openProject`, `writeFile`, `readAsset`, and server-push change notifications. *(Built in Phase 4: the push side is one `projectChanged` snapshot — changed texts plus a full inventory and hashes — rather than the per-file `fileChanged`/`fileRemoved`/`diagnosticsChanged` messages sketched here. Per-file messages cannot express "these five files landed together and the result validates", which §12 requires. Where this section and §12 disagree, §12 is the requirement and this was the sketch.)*
- **DSP in Rust / future Tauri backend:** Rust crate(s), introduced only if profiling shows the TS DSP core needs it, after the format and renderer are proven.
- **Schema → types:** generate TS types from JSON Schema only after proving the generator handles this schema's 2020-12 features. Use the generated or hand-written domain types in the format package, app, engine boundary, and sidecar protocol.

## 12. Two-way live sync (the genuinely hard part)

Mechanism:

1. **UI edit** → mutate model → serialize affected files (canonical) → enqueue a write batch → **debounced** write (~250 ms) via sidecar → record `{batchId, file, revision, writeId, contentHash}` for each file.
2. **Sidecar write batch** → validate path confinement for every file → write each file atomically → emit one batch acknowledgement with new sidecar revisions.
3. **Watcher fires** → coalesce filesystem events for a short settle window (~100 ms) → read changed files → if file hashes/write acknowledgements match the last write batch *we* made, it's our own echo → ignore. Otherwise treat it as an **external edit** (agent or hand-edit).
4. **External edit v1** → reparse changed files, rebuild affected project indexes, validate project-level invariants, then replace the affected model objects file-by-file. Preserve UI selection and expanded/collapsed state by stable IDs where possible. Do *not* promise minimal semantic patches in v1.
5. **Later refinement** → compute semantic model-domain patches (`setNote`, `replaceLaneSteps`, `setParamPoint`, `addClip`) only where they clearly improve undo or collaboration. JSON Patch paths are too low-level to be the primary undo/scheduler contract.
6. **During playback:** the scheduler reads immutable snapshots of the model each lookahead tick. Parameter tweaks can affect the next scheduling window. Structural changes (pattern length, clip add/remove, track routing) are queued to the next bar boundary unless playback is stopped. An *effect param* is a parameter change; an effect's *membership of the chain, or its position in it*, is structural, because what changed is the graph rather than how it sounds.

Concurrency policy (keep simple in v1, document clearly): if the UI has in-flight unsaved edits when an external edit lands on the same file, last-writer-wins with a visible warning and a retained diagnostic that names the file. Real merge/CRDT is a later concern; the per-file split already makes most collisions unlikely.

Single-writer assumption (v1): the sidecar admits one read-write UI session per project. A second browser connecting to an already-open project is rejected with a clear message ("project is open in another window"); admitting additional sessions as read-only followers is an easy later relaxation. This keeps last-writer-wins honest — only one UI holds optimistic unsaved state, so every other writer is a filesystem editor (the agent), which the echo/external-edit machinery in steps 3–4 already handles.

Undo policy: UI undo/redo applies only to local UI edit history. An accepted external edit becomes a new baseline and is not undone by pressing Undo. If an external edit lands while undo history exists, retain the history only when object IDs still resolve cleanly; otherwise clear the affected history segment and show a diagnostic.

Cross-file transactions: some UI operations must update multiple files. The sidecar protocol therefore needs write batches even though each file is written atomically. Watcher-side validation should tolerate transient invalid states during the settle window, but the browser should only accept a new project snapshot after project-level validation passes. Invalid external edits should surface diagnostics and keep the last valid in-memory model active.

**A batch is atomic per file, not across files, and that gap is real.** Every precondition in a batch is checked before anything is written, so the common failure — a stale hash, a path escape — rejects the whole batch untouched. But an I/O error on the second file of three leaves the first already renamed into place. The window is small and the settle-window tolerance above is what absorbs it, since the next scan sees a project that does not yet validate and holds the last good model rather than adopting a half-applied edit. Recording it rather than implying a guarantee the code does not make: a true cross-file transaction would need every temp file written and fsynced before any rename, which is worth doing only if this is ever observed to bite.

Echo detection is the linchpin. Get it right first in Phase 4, and encode every race in tests (§16): this code will not be human-reviewed, so the race tests *are* the correctness argument.

Five things learned building it, recorded because each one is a trap that passes a naive test:

- **Compare content, never elapsed time.** "Ignore watcher events for N ms after our own write" passes every obvious echo test and *silently eats* an agent edit that lands inside that window. The sidecar instead remembers the exact bytes it last established for each file and compares; matching bytes are an echo, differing bytes are external. Time is not an input.
- **Decide identity on full bytes, not on the hash.** The content hash is right for write preconditions and for telling the browser what changed, but a hash collision in the *identity* decision silently discards an agent's edit. The sidecar holds both strings already, so comparing them costs nothing worth saving. (Precisely: the hash is two 32-bit FNV-style words *plus the byte length*, so a colliding pair must also be equal-length — narrower than the "64-bit collision" this once said, and still not a coincidence worth betting an agent's work on.)
- **The infinite loop and the lost edit have different causes, so they need different guards.** Mistaking your own write for an external edit causes a reconcile storm and can drop unsaved work, but it does *not* loop, because adopting your own canonical bytes yields zero dirty files and therefore no write. The loop needs a distinct bug: making the raw disk bytes the persisted baseline, so every valid-but-non-canonical external edit reads as dirty → write → watch → adopt → forever. Test that mistake separately from echo detection.
- **A retraction is a message, not the absence of one.** If content is the only identity, an invalid state that is fixed by restoring a file *byte-identically* leaves nothing to report — and the UI sits insisting the project is broken forever. The sidecar must remember that it reported an invalid state and always announce the first validating snapshot afterwards, even when that snapshot carries no changed files. Silence cannot clear a warning.
- **A diff and a full snapshot need opposite readings of an absent file.** In a diff, a document the inventory does not name is evidence the client is out of sync; in a full snapshot it is a deletion the client was never told about. A protocol that does not distinguish the two either loses a file or reports a false desync, so the message carries an explicit scope.

Loading the project must also be atomic with respect to the watcher. Fetching documents one at a time lets an agent's edit land mid-load, and the resulting mixed model is *not* reliably caught later — the next push names a file the torn read already picked up, so the client sees nothing new and returns early before any inventory check. One request returning every document from a single `loadProject` removes the race rather than detecting it.

## 13. The CLI (agent's feedback loop + the test harness)

```
musictool validate <project>      # JSON Schema + pattern-grammar + semantic checks,
                                   #   with actionable diagnostics and suggested fixes
musictool fmt <project>           # canonical formatter → identical bytes from any writer
musictool describe <project> [--json]
                                   # human/agent summary: tracks, bars, key, density
                                   #   (--json is the machine mode; golden tests assert on it)
musictool render <project> [--out out.wav] [--bars 0-8] [--stems] [--seed N] [--analyze]
                                   # deterministic offline render (Phase 1) — the agent's ears
```

There is deliberately no separate `doctor` command: `validate` itself emits rich diagnostics with suggestions. One command, one exit code, one JSON output for agents to consume.

`render` is the second half of the loop and is specified here because its flags are part of the agent contract:
- `--bars 0-8` renders a range, so the agent can check just the section it changed, fast.
- `--stems` writes one WAV per track alongside the master, so the agent can isolate what each track contributes.
- `--seed N` seeds the PRNG used to resolve `probability`; the default seed is fixed, so renders are reproducible by default. Seed derivation must be stable per event *and* order-independent: the hash covers seed + track + pattern + the clip's `startTick` + repetition index + the event's position within the pattern (lane and step for a grid hit; `startTick`, MIDI pitch, and `durationTicks` for a note event), and no array position of any kind — not a clip's, not a note's. Editing one lane, or inserting, removing, or reordering a clip or a note, therefore leaves every other event's outcome bit-identical on every track; only editing an event itself, or moving its clip to a different `startTick`, re-rolls anything, and a move re-rolls only that clip's own events. It follows that `fmt`, which sorts `clips` and `notes`, can never change the rendered audio.
- `--analyze` writes a machine-readable JSON report alongside the audio: per-track and master peak/RMS loudness, clipping detection, silence detection ("track rendered but produced silence" is a classic agent failure and must be loud), detected onset times compared against the compiled event schedule (so "kick onsets land on beats 1-2-3-4" is checkable), and a coarse spectral summary (band energies / centroid) per track.

Two design rules the analysis must obey, both learned by getting them wrong first:

- **Look for sound that should not be there, not only sound that should.** An onset check that only
  counts detected onsets *matching* an expected position can never exceed the expected count, so it
  hands out a clean bill of health on audio containing extra unscheduled hits — a doubled clip, a
  runaway ratchet, a choke group that failed to cut. That is confirmation bias encoded into the one
  signal the agent trusts. Report unmatched detections (`spurious`) alongside unmatched expectations.
- **A warning that fires on healthy projects is worse than no warning**, because agents learn to skip
  the `warnings` array wholesale. An energy-rise detector legitimately fires on filter sweeps and
  automation jumps, so report counts as data always but gate the *warning* behind a named, reported
  threshold. Every threshold and band edge belongs in the report itself (`parameters`), so the numbers
  are self-describing and an agent knows what "silent" or "matched" meant without reading our source.
- **Distinguish "silent with no events" from "silent with events."** The former is normal (the worked
  example's `pad` track); the latter means the author wrote notes that made no sound, and is the
  single highest-value warning in the system.

Known limits of onset analysis, recorded so nobody mistakes them for bugs:

- **A voice's envelope peak can lag its note start.** A low-frequency resonant voice (55 Hz through
  `filter.resonance: 200`) is loudest on its *second* oscillator cycle, ~20 ms in. No rise test can
  distinguish that from a genuine extra hit 7% louder at the same distance, so candidates within a
  named maximum attack lag (~30 ms) after a scheduled position are attributed to that event. The cost
  is a blind spot: genuinely unscheduled sound inside that window is not reported. At 124 BPM that is
  about a quarter of a 16th note, so ratchets and displaced hits stay visible. This is an explicit
  engineering judgement, expressed as a named constant and pinned by a test on both sides of the
  boundary — not a tuning artefact.
- **Onsets at sample 0 need an implicit silent baseline.** A rise detector that averages only the
  frames that exist will use the transient itself as its own baseline at the start of a buffer and
  miss the hit entirely. Nearly every drum pattern starts on beat 1, so this case is the rule rather
  than the exception. Frames before sample 0 must count as zero energy.
- **Simultaneous identical events are one observable onset.** Coincident scheduled events collapse,
  and a doubled clip at the same tick is genuinely indistinguishable in audio from one louder hit —
  that class of mistake is caught by `describe`, not by listening.

Diagnostics must include file path, JSON pointer or pattern-string span, line/column where available, severity, and a short suggested fix. Agents act much more reliably when they can run one command and see exactly where a mistake is.

Every diagnostic is a structured object — the same shape emitted by `validate` and pushed over the sidecar `diagnosticsChanged` message:

```json
{
  "severity": "error",
  "code": "pattern.step-count-mismatch",
  "file": "patterns/drums-verse.json",
  "pointer": "/lanes/0/steps",
  "span": { "start": 12, "end": 13 },
  "loc": { "line": 5, "column": 14 },
  "message": "lane 'kick' has 15 steps but stepsPerBar*bars = 16",
  "suggestion": "add one '.' to reach 16 steps"
}
```

- `severity` is `error | warning | info`; `validate` exits non-zero if any `error` is present.
- `code` is a stable, namespaced, machine-readable identifier so agents and tests assert on specific diagnostics without matching prose.
- `pointer` is an RFC 6901 JSON Pointer into the file; `span` is a character range into a pattern string when the error is inside one; `loc` is line/column when available. At least one locator is always present.
- `describe --json`, `validate --json`, and `render --analyze` all have machine modes; golden/diagnostic tests assert on the JSON and the human-readable text is rendered from it, so prose wording can change without breaking tests.

## 14. Audio engine specifics

- **One DSP core (§11).** Oscillators (PolyBLEP or similar for alias-reduced saw/square), biquad filter, ADSR envelopes, sample playback with pitch shift, per-voice gain/pan — written as pure TypeScript block processors. The offline renderer and the live AudioWorklet both run this exact code.
- **Shared event compiler (§11).** `compile(document, seed)` produces the sample-accurate schedule (swing, microTicks, ratchets, gates, probability resolved via seeded PRNG, automation curves sampled). Both render and live playback consume it; tests assert on it directly and exactly.
- **Offline render determinism.** Fixed default sample rate (48 000 Hz), fixed block size, seeded PRNG. One caveat is encoded as policy: JavaScript's `Math.sin`/`Math.exp` etc. are implementation-defined, so if byte-identical golden WAVs are wanted across engines/platforms, the DSP core must use its own deterministic approximations or tables for transcendental functions. Until it does, golden audio tests assert on the compiled event schedule *exactly* and on `--analyze` metrics *within small tolerances*, not on WAV bytes.
- **Live scheduler:** lookahead pattern (Chris Wilson's "A Tale of Two Clocks") — a timer that looks ~100 ms ahead and posts upcoming schedule slices to the worklet against `AudioContext.currentTime`. Never time notes with raw `setTimeout`. Because the schedule comes from the shared compiler, a live-vs-offline equivalence test (same document, same seed → same event schedule) keeps the two paths honest.
- **Autoplay policy:** browsers require the `AudioContext` to be resumed from a user gesture. Bake a "click to start" into the UX; don't fight it.
- **Samples:** the engine loads project-relative samples through the sidecar asset endpoint, not direct filesystem paths. Cache by content hash so replacing `samples/kick.wav` invalidates correctly. *(Built: the watcher covers `samples/**` and a running app adopts a replaced WAV at the next trigger, so live playback and a fresh render agree — verified at −4.37 dBFS on both paths after a mid-playback swap.)*
  - **A sample change is not a document change**, and must not be smuggled into a document snapshot: it alters no JSON, so it carries its own message and its own inventory of paths and content hashes. The two can arrive together — an agent adds a kit voice *and* drops in the WAV it names — and samples must be announced first, because a graph naming content the worklet has not been sent is rejected.
  - **Swap for the next trigger, not for sounding voices.** A voice must capture its buffer at trigger and play out on it, including its length and retirement. Reading the current buffer per sample splices two waveforms mid-voice: a click *and* a wrong playback rate. Deferring the swap to a bar boundary instead would make a sample edit feel broken.
  - **Identify samples by content hash, not by holding their bytes.** This is the one place the document rule in §12 is deliberately inverted: keeping a copy of every sample would put a project's entire audio in the sidecar's heap, and the hash is *already* the end-to-end identity — the engine's cache and the worklet's own check are keyed by it, so a collision serves the stale decode regardless of what the watcher compared. Time is still never an input.
- **Worklet packaging:** bundle all processors into one AudioWorklet module and register the processor classes from it; keep the worklet's message protocol (schedule slices in, meters/position out) small and typed.
- **Effects** (delay, reverb, per-track filter) are pure block processors in the same core, so the offline renderer and the worklet run identical code and stay bit-identical including tails — which is the case most likely to diverge and least likely to show it, since a chain reset on a slice boundary yields a slightly different tail and identical onsets, levels and event counts. Every recursive state write is flushed to exact zero below a silence floor: the bug to prevent is not a denormal *performance* cliff, which JS does not have, but a tail that never terminates — and it would become a speed bug in a Rust/WASM port. Feedback and reverb size are bounded by their declared registry ranges rather than by a runtime clamp, so stability is a property of the format rather than of a guard nobody can see.
- **Future heavy DSP:** Rust→WASM inside the same worklet, behind the same block-processor interface, only if profiling demands it.

## 15. Local-first now, deployable later

The fork in the road is how the browser reaches the filesystem. Three options:

- **(a) File System Access API** — pure browser, no install, but Chromium-only and watch is poll-based. Weakest watch story.
- **(b) Thin local sidecar** *(recommended)* — robust watch, works in any browser, can safely serve project-local sample assets, and its WebSocket/HTTP protocol **is the same shape as the eventual server API** (swap local fs for server storage and the browser barely changes). The agent-edits-files flow works perfectly because the sidecar is the fs authority.
- **(c) Tauri from day one** — Rust backend gives real fs + watch; natural given the maintainer's Rust background; means desktop is mostly already done. Reasonable to pick first instead of (b); the only cost is leaving pure-web until later.

Recommendation: **(b)** for v1 (keeps web-first, generalises cleanly to server), with **(c)** as the desktop step. Start the sidecar in Node to share the TypeScript format package and move to Rust/Tauri only when the product shape is proven.

**Evolution to deployed:** the document stays a portable bundle, so "stored on a server" is a storage + auth change, not a redesign. The in-app AI assistant (user supplies their own API token, app calls a model to edit the document) reuses the *same* apply-patch primitive — the model is just another editor emitting changes to the same format. **Do not build two AI paths.** Later, expose the document primitive over **MCP** so external agents get a clean tool surface — but it's the same underlying edits.

## 16. Phasing & acceptance criteria

**Phase 0 — format & validator foundation** *(no UI, no audio)*
TypeScript workspace, schema, canonical parser/serializer (strict JSON in, canonical JSON out), the v1 pattern-string grammar + parser, engine parameter registry, `validate`/`fmt`/`describe` CLI, the §8 worked example as a fixture, tiny test `.wav` samples, invalid fixtures, `format-spec.md`, `AGENTS.md`.
Done when: an agent hand-edits a project and it validates; parse→serialize is idempotent (round-trip stable); `fmt` output is byte-stable including canonical `steps` strings; a file containing comments fails with the §5 diagnostic; invalid fixtures fail with useful diagnostics; all persisted numbers are integers in their declared unit (no floats anywhere in canonical files, including tempo); a `format: 2` project is rejected rather than migrated; per-step grid expression and automation-param validation are covered by fixtures.

**Phase 1 — offline renderer & the full agent loop** *(still no UI)*
The shared event compiler, the TypeScript DSP core, the Node offline renderer, and `render` with `--bars`, `--stems`, `--seed`, `--analyze`. Golden tests on compiled event schedules (exact) and analysis metrics (tolerance).
Done when: the §8 fixture renders to a WAV whose analysis shows kick onsets at the compiled schedule times, an audible bass, and no unexpected silence or clipping; renders are reproducible under the default seed and per-event seed derivation is stable under unrelated edits; stems and bar-range renders work; replacing a sample file changes the render.
Also done when (the ergonomics gate — the real exit criterion): given only `docs/format-spec.md`, `AGENTS.md`, and the CLI — no other context — a fresh agent can complete a realistic task such as "add a four-on-the-floor kick and a bassline that follows it," produce a project that passes `validate`, and confirm via `render --analyze` that the kick lands on the beats and the bass is audible, without human hand-holding. If that loop is painful, the format or the tooling is not done.

**Phase 2 — live audio engine MVP**
Load document → play in the browser: AudioWorklet running the DSP core, lookahead scheduler feeding it compiled schedule slices, sidecar sample loading, transport with click-to-start (headless or trivial UI).
Done when: the fixture plays back; a live-vs-offline test proves the same document and seed produce the same event schedule on both paths; sample replacement invalidates the cache.

**Phase 3 — web UI (read + edit)**
Step sequencer + piano roll + transport, rendered from the document. Editing mutates the model and writes files via the sidecar.
Done when: editing in the UI updates the file; opening a file shows it correctly.

**Phase 4 — two-way live sync**
Sidecar watcher, authenticated local protocol, Host/Origin checks, write batches, atomic per-file writes, content-hash/write-ID echo detection, file-granular external-edit reconcile, debounced writes.
Done when: Claude Code edits a track file and the UI updates live without reload; a UI edit produces a clean, minimal diff; watcher race tests cover own-write echoes, external edits, delete/recreate, invalid intermediate files, and multi-file write batches.

**Phase 5 — expressive UI/audio depth**
Full UI/audio support for automation lanes, per-note/grid expression (velocity, micro-timing, gate, probability, ratchets), swing, mixer + effects; Rust→WASM DSP only if profiling demands it.
Done when: the Phase 0 expression model is editable and audible; a groove with swing + automation renders with analysis confirming the expected timing offsets, and the human confirms it sounds musical rather than quantised.

**Phase 6 — desktop & deploy** *(later)*
Tauri wrap → server storage + auth → in-app assistant (user token) → MCP server over the document primitive.

## 17. Repository layout

```
/packages/format      schema, canonical parser/serializer, pattern grammar, semantic validation
/packages/engine      event compiler, TS DSP core, offline renderer, analysis, worklet binding
/packages/cli         musictool CLI using /packages/format and /packages/engine
/app                  React + Vite web UI
/sidecar              local fs bridge, watcher, authenticated WebSocket/HTTP, sample assets
/crates               Rust DSP / WASM / future Tauri backend (create only when needed)
/fixtures/valid       example projects, including the §8 worked example
/fixtures/invalid     broken projects used to test diagnostics
/fixtures/golden      golden event schedules, describe/analyze JSON, canonical bytes
/docs                 format-spec.md, AGENTS.md, this PLAN.md
```

## 18. Risk register & correctness strategy

The overriding constraint: **no human reviews the implementation.** The maintainer directs the product and judges the music by ear; Fable-class agents write and maintain all code, including DSP, scheduling, and sync. Correctness therefore cannot rest on review — every property that matters must be encoded in a test the CI runs. If a property is not tested, it is not guaranteed; when a bug is found, the fix ships with the test that would have caught it. The architecture is deliberately shaped for this: musical correctness concentrates in pure, exhaustively testable code (canonical serializer, event compiler, DSP core, analysis), and the untestable surface (Web Audio plumbing, UI) is kept thin.

- **The format is hardest to change.** Stabilise Phase 0 before building on it. Changing the schema after the UI and engine bind to it is expensive.
- **Mixed timing units are fatal.** Persist ticks everywhere. Beat/bar floats may appear in UI labels, never in canonical project files.
- **Never round a duration; difference two rounded positions.** *(Learned the hard way in Phase 1.)* An event spanning ticks [a, b) has `durationSamples = tickToSample(b) - tickToSample(a)`. Rounding the tick *length* on its own leaves one-sample gaps or overlaps between back-to-back events whenever samples-per-tick is non-integer (124 BPM at 960 PPQN and 48 kHz is 750/31), which surfaces as clicks in the render and is miserable to trace back from the audio. The same rule makes ratchets tile their gate exactly by construction, with no remainder-distribution logic. Any future port must preserve this.
- **Never key a per-event hash on an array position.** *(Learned the hard way in Phase 1.)* The `probability` identity first used the clip's index in `arrangement.clips`, so inserting or reordering any clip re-rolled which events fired on every *other* clip and track — the exact opposite of the §13 guarantee the render-verify loop rests on, and invisible in a diff. The same mistake was hiding one level down: a note's identity used its index in `pattern.notes`, which `fmt` sorts, so formatting a project — the very thing `AGENTS.md` tells agents to run — could change which notes fired, and the event count could stay put while the outcomes swapped. Per-event identities must be built from musical coordinates only (track, pattern, clip `startTick`, repetition, then lane + step for a grid hit or `startTick` + MIDI pitch + `durationTicks` for a note); any future port must too.
- **Pattern strings must stay deterministic.** `steps` is placement-only; expression lives in sorted `stepEvents`; `fmt` owns spacing and case.
- **Parameter validation is part of the music model.** Engine params and automation params must be checked against the registry, or agents will silently create broken automation.
- **Split canonical implementations create invisible divergence.** Keep the parser/formatter/validator in one TypeScript package reused by CLI, UI, sidecar, and tests; keep the DSP core in one package reused by renderer and worklet.
- **Live/render divergence.** If live playback and offline render ever use different engines, "sounded great in the render, wrong in the app" becomes undebuggable. One DSP core, one event compiler, and a schedule-equivalence test are the guard.
- **Cross-language number divergence.** Canonical files contain no floats — every quantity is an integer in a registry unit (§6/§6.2), including tempo as bpm×100 — so byte-identical output across TS and any future Rust serializer reduces to integer printing. A cross-implementation golden test must assert byte-identical serialization of the fixtures, and any future float parameter must ship with a defined canonical precision before it is allowed in.
- **Audio golden-test brittleness.** JS transcendental functions are implementation-defined (§14). Assert exactly on compiled event schedules; assert with tolerances on analysis metrics; only assert on WAV bytes once the DSP core uses its own deterministic math.
- **An LTI cascade commutes, so a static effect chain's order reaches nothing but rounding.** *(Learned while adding effects, from a test that was passing on noise.)* Delay, reverb and filter are each linear and time-invariant while their params hold still, and reversing such a cascade changed the output by 1.9e-6 of peak — float32 error. So a test that compares *two orderings* and asserts they differ passes with the chain applied backwards. Pin the direction against a cascade computed by hand instead, and assert the commutation fact separately so nobody later reads it as a bug. Under automation the filter is no longer time-invariant and the same reversal differs by 382× peak, which is why the order is still `structural` and still worth getting right.
- **Ask onset questions of the source bus, not the audible one.** A delay's repeats and a reverb's tail are deliberate sound at positions nothing scheduled, so "does the audio match the schedule?" asked of the wet signal reports a healthy reverb as hundreds of spurious onsets — the §13 false positive that trains agents to ignore warnings. Measure onsets pre-effect and levels post-effect: an onset question is about the source, a level question is about the output. The invariant to hold onto is that adding an effect cannot move an onset, which is checkable by stripping the chains and comparing position for position.
- **Comments do not exist in this format.** Strict JSON: a `//` in a hand-edited file is a parse error with a diagnostic pointing at `description`/`notes` fields. `AGENTS.md` must state this loudly.
- **Schema tooling can lie by omission.** Test Ajv 2020-12 mode and any TS type generator against the actual schema features before trusting them.
- **Scheduler, DSP & sync correctness without review.** The classic LLM failure mode ("compiles, sounds nearly right, glitches under load") is countered by determinism and tests, not by eyeballs: schedule golden tests, analysis assertions, live/offline equivalence, and the §16 watcher race suite (echoes, external edits, delete/recreate, invalid intermediates, multi-file batches). Sync and echo-detection bugs (infinite loops, lost edits) live or die by that race suite.
- **External edits are not local undo.** Treat accepted external changes as a new baseline unless a later collaboration model deliberately changes that policy.
- **Sidecar security.** Localhost filesystem tools are attack surfaces. Token auth, Host/Origin checks, path confinement, message limits, and atomic writes are not optional, and each needs a test (path escape attempts, missing token, bad Origin).
- **Don't let agent-legibility distort the musical model.** Keep ticks, swing, micro-timing first-class even though they make the schema less tidy.
- **Per-voice render buffers scale with kit size.** *(Noted in Phase 1, deliberately not solved.)* `render --analyze` holds one full-length stereo buffer per track *and* per kit voice so a drum voice can be measured on its own audio; a 12-voice kit over five minutes is roughly 1.4 GB. Agents overwhelmingly render `--bars` ranges, which is the mitigation; if it ever bites, the fix is to produce and analyse voices one at a time rather than all at once, not to drop per-voice analysis.
- **Sample portability.** Always project-relative paths; never absolute (the REAPER mistake).
- **Fixture drift.** The worked example is a contract. Keep valid fixtures complete and invalid fixtures intentionally broken.

## 19. First actions for the agent

1. Scaffold the TypeScript monorepo (§17) with package workspaces; set up lint/test/CI. Do not add Rust workspace scaffolding until a later phase actually needs it.
2. Write `docs/format-spec.md` from Part One; create `AGENTS.md`.
3. Implement the JSON Schema Draft 2020-12 schemas for `project / track / pattern / instrument / automation / arrangement` and validate the TS type-generation path against tuples and closed objects.
4. Build the canonical parser/serializer in `/packages/format`: strict JSON read with duplicate-key rejection and the comment diagnostic, canonical readable JSON write, path/id validation helpers, integer normalisation, canonical `steps` formatting.
5. Implement the v1 pattern-string grammar + parser with location-aware errors and sparse `stepEvents` expression validation.
6. Implement `validate`, `fmt`, and `describe`; add the §8 worked example under `/fixtures/valid` with tiny test `.wav` samples.
7. Add the built-in engine parameter registry and validate instrument params plus automation target params.
8. Add invalid fixtures for bad IDs, absolute sample paths, `..` paths, wrong step counts, non-integer values (including a float tempo), missing references, unknown fields, malformed pattern strings, bad `stepEvents`, bad engine params, non-automatable params, duplicate automation lanes, unsupported mixed pattern representations, `trackOrder` mismatches (unknown id, duplicate), a dangling sample reference, a non-WAV/oversize sample, a `format: 2` project, a file containing comments, and an `X` accented trigger.
9. Write round-trip tests (parse → serialize → parse identical; `fmt` byte-stable) and golden-output tests for `describe --json` and `validate` diagnostics, plus a cross-implementation byte-identical serialization harness (single implementation now, ready for a second).
10. Proceed directly into Phase 1: shared event compiler with golden schedule tests, TS DSP core, offline renderer, `render --analyze/--stems/--bars/--seed`, and analysis golden tests.
11. Run the ergonomics gate (§16) at the end of Phase 1: hand a fresh agent only the spec, `AGENTS.md`, and CLI, and confirm it can complete a realistic edit task, validate it, and verify it audibly landed via `render --analyze`.

Pause at the end of Phase 1 for the human to listen to the fixture render and confirm the format and the sound feel right before building the live engine and UI on top — that review is the cheapest it will ever be.

## 20. External technical context checked

These are not dependencies to blindly copy; they are context anchors for future agents.

- **RFC 8785 / JSON Canonicalization Scheme:** useful model for deterministic JSON, I-JSON constraints, stable primitive serialisation, and property ordering. This project uses a readable canonical JSON variant instead of raw compact JCS.
- **JSON Schema Draft 2020-12:** current schema baseline for tuple validation (`prefixItems`), composed closed objects (`unevaluatedProperties`), and modern validators such as Ajv 2020.
- **Strudel mini-notation:** validates the premise that compact musical text is agent-friendly, but its cycle-relative timing is intentionally not copied into this bar/beat/tick sequencer.
- **Web Audio / AudioWorklet:** custom low-latency DSP belongs in AudioWorklet; WASM can run there for heavier processors. The lookahead scheduling pattern is Chris Wilson's "A Tale of Two Clocks."
- **Tone.js:** good reference for transport/scheduling design, but not a dependency — the one-DSP-core decision (§11) replaces both its live engine and its offline rendering path.
- **Browser autoplay policy:** the app must create or resume `AudioContext` from a user gesture.
- **File System Access API:** useful for pure-browser read/write, but not enough for robust agent-edits-files live watching; the sidecar remains the v1 path.
- **WebSocket local security:** localhost filesystem bridges still require token auth, Host/Origin checks, path confinement, message limits, and avoiding token leakage in URLs.
