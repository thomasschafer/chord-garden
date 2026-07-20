# Project format spec (v1)

This is the authoritative reference for the on-disk project format. It is
generated from and must stay consistent with `PLAN.md` Part One; if they
disagree, treat that as a bug and fix the mismatch. Agents editing a project
should read this file and `AGENTS.md` before making changes.

## 1. A project is a directory

```
my-track/
  project.json
  tracks/<id>.json
  patterns/<id>.json
  instruments/<id>.json
  automation/<track-id>.json
  arrangement.json
  samples/*.wav
```

Every file is strict JSON (RFC 8259 — no comments, no trailing commas, no
duplicate keys) and is validated both by a JSON Schema (shape) and by
semantic rules (cross-file references, ranges, units). Run `musictool
validate <project>` to check both.

IDs are lowercase kebab-case: `^[a-z][a-z0-9-]*$`. A file's `id` field (or
`track` field, for automation files) must equal its file name. `project.json`
and `arrangement.json` are singletons with no `id`.

## 2. Numbers are always integers in a fixed unit

**No file in this format ever contains a floating-point number.** Every
persisted quantity is an integer in one of these units:

| unit | meaning | example |
|---|---|---|
| ticks | absolute time at the project's `ppqn` | `startTick: 960` |
| `permille` | 0–1000 (or ±1000 bipolar) representing 0.0–1.0 | `velocity: 800` = 0.8 |
| `ms` | milliseconds | `amp.attack: 5` |
| `Hz` | hertz | `filter.cutoff: 12000` |
| `cents` | 100 = one semitone | `detune: -1200` = one octave down |
| `dB×100` | hundredths of a decibel | `gain: -600` = −6 dB |
| `bpm×100` | hundredths of a BPM | `bpm: 12400` = 124.00 BPM |
| `count` | plain non-negative integer | `maxVoices: 16` |

`128.5` BPM is `12850`. `0.8` probability is `800`. There is no exception to
this rule; a float anywhere in a canonical file is a validation error
(`number.float`).

## 3. Musical time

- `ppqn` (pulses per quarter note) lives in `project.json` and is fixed for
  the life of the project.
- `ticksPerBar = ppqn * 4 * timeSignature[0] / timeSignature[1]`. At 960 ppqn
  and 4/4, one bar is 3840 ticks.
- Pattern-local events (`startTick` inside a pattern) are ticks from the
  start of the pattern. Arrangement clips and automation points are ticks
  from the start of the song.
- `project.json.tempoMap` and `.meterMap` are arrays of points, each starting
  at tick 0. **v1 requires exactly one point in each map** — the map shape
  exists so a later version can add tempo ramps and meter changes without a
  breaking format change, but v1 validators reject anything but one point.
- There is no separate convenience `tempo`/`timeSignature` field — `tempoMap`
  and `meterMap` are the only source of truth, so there is nothing to keep in
  sync.

## 4. Swing

`project.json.swing` (permille, default 0) applies to every grid lane. A
lane may override it with `defaults.swing`. Every odd-indexed step in a lane
is delayed by `round(swing * stepTicks / 2000)` ticks, applied before
`microTicks`. Swing is a lane/project setting, not a per-step field — for a
single step's timing nudge use `microTicks` in `stepEvents`.

## 5. Pattern strings (grid lanes)

A grid pattern lane is a compact placement string, not a list of event
objects:

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

Grammar (v1, deliberately small):
- `x` — a hit. `.` — a rest. Spaces are cosmetic and never counted.
- `|` — optional bar separator; must fall on a bar boundary if present.
- `X` (accent) and `-` (tie) are **reserved and rejected** in v1 — the
  validator points at the exact column and tells you what to use instead
  (`velocity` in `stepEvents` for accents; ties are unimplemented).

Required step count is `stepsPerBar * (lengthTicks / ticksPerBar)`. Each grid
step must map to a whole number of ticks — `ticksPerBar % stepsPerBar` must
be 0.

`defaults` sets lane-wide expression (`velocity`, `gateTicks`, `probability`,
`swing`); `stepEvents` sparsely overrides individual `x` steps by zero-based
index. A `stepEvents` entry may only target a step that is actually a hit;
targeting a rest is an error (`pattern.step-event-not-a-hit`).

`musictool fmt` owns canonical formatting of `steps`: blocks of four
(or the largest divisor of `stepsPerBar` that is ≤4, or ungrouped if none),
` | ` between bars, `stepEvents` sorted by `step`. Never hand-format a steps
string and expect it to survive `fmt` unchanged unless it's already
canonical.

A pattern is either `kind: "grid"` (drum tracks, lanes as above) or `kind:
"notes"` (melodic tracks, a flat note event list with `pitch`, `startTick`,
`durationTicks`, `velocity`, and optional `microTicks`/`probability`/
`ratchet`). Never both.

## 6. Instruments and the parameter registry

Every built-in engine (`basic-mono`, `basic-poly`, `drumkit`) declares a
fixed set of valid `params` keys, each with a unit, range/enum, default, and
whether it's automatable. `validate` checks every `params` entry and every
automation target against this registry; an unknown key gets a "did you
mean" suggestion instead of silently passing.

Shared subtractive params (`basic-mono`, `basic-poly`): `oscillator`,
`detune`, `filter.type`, `filter.cutoff`, `filter.resonance`,
`filterEnv.amount`, `amp.attack`, `amp.decay`, `amp.sustain`, `amp.release`,
`gain`, `pan`. `basic-mono` adds `portamento`; `basic-poly` adds `maxVoices`.

`drumkit` params are namespaced per voice: `<voice>.gain`, `<voice>.pan`,
`<voice>.pitch`, `<voice>.chokeGroup`, where `<voice>` must be a key in the
instrument's `kit` map. The full table with ranges and defaults is in
`PLAN.md` §6.2 — treat that table as canonical; this file just states the
key names.

## 7. Arrangement and automation

`arrangement.json` holds only the timeline: `lengthTicks` and `clips`
(`track`, `pattern`, `startTick`, `repeatCount`). A clip's `startTick +
repeatCount * pattern.lengthTicks` must not exceed `lengthTicks`.

Automation is **per track**, in `automation/<track-id>.json`, not embedded in
`arrangement.json` — this keeps arrangement diffs small and automation edits
from colliding with clip edits. Each lane names a `param` (must be
automatable on that track's instrument), an `interp` (`linear` or `step`),
and strictly-increasing `[tick, value]` points, value in the param's unit. At
most one lane per param per track.

## 8. Samples

Samples live under `samples/`, referenced by project-relative path (e.g.
`samples/kick.wav`). Absolute paths and `..` are errors. v1 accepts
uncompressed PCM WAV only, validated by extension and header, with a 50 MB
per-file cap. A referenced sample that doesn't exist on disk is an error
naming the missing path.

## 9. Validation model

JSON Schema (Draft 2020-12) covers shape: required fields, types, enums,
ranges, tuple arrays (`prefixItems`), closed objects
(`unevaluatedProperties: false`). Everything schema can't express —
cross-file references, the registry, pattern-string parsing, sample
existence, tempo/meter map cardinality — is semantic validation in code.

Every diagnostic (from either layer) is one shape:

```json
{
  "severity": "error",
  "code": "pattern.step-count-mismatch",
  "file": "patterns/drums-verse.json",
  "pointer": "/lanes/0/steps",
  "loc": { "line": 5, "column": 14 },
  "message": "lane 'kick' has 15 steps but stepsPerBar*bars = 16",
  "suggestion": "add one '.' to reach 16 steps"
}
```

`code` is stable and namespaced — write tooling and tests against `code`,
never against `message` prose, which can change. `severity` is
`error | warning | info`; `validate` exits non-zero only on `error`.

## 10. Versioning

`project.json.format` is `1`. `validate` rejects a project whose `format` is
newer than what the tool supports — it does not attempt to migrate. Breaking
changes bump `format`; additive non-breaking changes keep `format` the same
but must still round-trip through canonical formatting unchanged.

## 11. What's deliberately not in v1

- Cycle-relative pattern timing (Strudel/Tidal-style) — this format is
  bar/beat/tick-absolute.
- Advanced pattern grammar: `*` repeat, Euclidean rhythms `(3,8)`, nested
  groups, random choice — add only after the basic grammar has golden tests.
- Melodic grid patterns and ties (`-`).
- Tempo ramps and meter changes (the map *shape* is reserved, but v1
  validators require exactly one point).
- Third-party/plugin engines — the registry is closed to the three built-in
  engines for now.
