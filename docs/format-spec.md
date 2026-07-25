# Project format spec (v1)

This is the authoritative reference for the on-disk project format. It is
generated from and must stay consistent with `PLAN.md` Part One; if they
disagree, treat that as a bug and fix the mismatch. Agents editing a project
should read this file and `AGENTS.md` before making changes. This file is
self-sufficient: it defers nothing to `PLAN.md`, so everything needed to write
a valid project — including the full parameter registry (§6) — is here.

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
persisted numeric quantity is an integer in one of these units:

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

The rule is about numbers, and not every field is one. The fields that are
strings, and so appear in no unit table: a note event's `pitch`, which is a
note name like `"A1"` and **not** a MIDI number — `"pitch": 33` fails
validation, `"pitch": "A1"` is that same note (grammar in §5.1); a grid lane's
`steps` placement string (§5); enum params such as `oscillator`, `filter.type`
and an automation lane's `interp` (§6, §7); and `id`, `description`, `name`,
`key.root`, `key.scale`, and sample paths. Every other persisted value is an
integer in a unit above.

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

Steps at even indices are never swung, whatever `swing` is. Step indices are
zero-based across the whole pattern, so four-on-the-floor at 16 steps per bar
(steps 0, 4, 8, 12) is swing-immune, while the same kick syncopated onto an odd
step is displaced — with nonzero `swing` that is the difference between a hit
on the beat and a hit behind it. A lane whose hits are all on even steps sounds
identical at every `swing` value.

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

A lane's `lane` name is not free text: it must be a key in the `kit` map of the
instrument used by the track that plays this pattern (§6). A name that isn't is
an error, `pattern.lane-unknown-voice`, with a "did you mean" suggestion. The
check runs per track→pattern reference, so a pattern reached by two tracks is
checked against both kits, and a pattern no track references is not checked at
all (it is already reported as `orphan.pattern`).

`probability` (permille, in `defaults` or a `stepEvents` entry, and on note
events) is resolved deterministically at render time from the render seed
(`render --seed`, default 0) hashed with the event's identity: track, pattern,
the playing clip's `startTick`, repetition index, and the event's position
within the pattern — for a grid hit its lane and step, for a note event its
`startTick`, pitch as a MIDI number, and `durationTicks`. The same project and
seed therefore always drop the same events.

That identity holds no array position of any kind: not a clip's index in
`arrangement.json`, not a note's index in its pattern's `notes`, not a
`stepEvents` index. Inserting, removing, or reordering a clip or a note — by
hand or via `fmt` — leaves every *other* event bit-identical, on every track and
in every pattern: an agent can add a clip or a note and trust that the rest of
the render, and any analysis numbers it just verified, are unchanged, and
running `fmt` cannot change a single sample of the audio (§5.2). The two edits
that do re-roll an event are an edit to the event itself and moving its clip to
a different `startTick`, which is a different musical position; a move re-rolls
only that clip's own events. A note's pitch enters the identity as its MIDI
number, so respelling `A#1` as `Bb1` — which changes no sound — re-rolls
nothing either.

Two events indistinguishable to the identity roll together. That is two clips
sharing a track, a pattern, and a `startTick`, and two notes in one pattern
sharing a `startTick`, MIDI pitch, and `durationTicks`. Those are exactly the
fields canonical order sorts by (§5.2), so a colliding pair is exactly a pair
canonical order ties — one whose array position is therefore not a
well-defined property of the project and cannot be keyed on at all (§7). Both
fire or both drop, which is what a duplicate at one position should do.

A pattern is either `kind: "grid"` (drum tracks, lanes as above) or `kind:
"notes"` (melodic tracks, a flat note event list with `pitch`, `startTick`,
`durationTicks`, `velocity`, and optional `microTicks`/`probability`/
`ratchet`). Never both.

### 5.1 Note pitch

`pitch` is a note name string — the one persisted musical quantity that is not
an integer (§2). The grammar is exactly `^[A-G][#b]?(-1|[0-9])$`:

- one uppercase letter `A`–`G`;
- optionally one accidental, `#` (sharp) or `b` (flat) — both are accepted, and
  they are the only accepted spellings (no `♯`/`♭`, no `##`, no `bb`, no
  natural sign);
- then the octave, `-1` through `9`, with no separator.

`C4`, `Bb2`, `F#-1` are valid. `"bb2"`, `"Gbb2"`, `"A#10"`, `"C 4"`, and `"33"`
are not, and fail as `schema.pattern` at that note's `/pitch` pointer. A bare
number — `"pitch": 33` — fails one step earlier, as `schema.type`.

Octaves follow the MIDI convention in which middle C is `C4`:

```
midi = pitchClass + accidental + (octave + 1) * 12
```

with `pitchClass` C=0, D=2, E=4, F=5, G=7, A=9, B=11 and `accidental` +1/−1/0.
So `C-1` is MIDI 0, `C4` is MIDI 60, and `A4` is MIDI 69, which the engine
renders at 440 Hz. The concrete anchor: **`A1` is MIDI 33 and sounds at 55 Hz**
— if you expected `A1` to be 110 Hz you are thinking of a numbering one octave
lower than this one, and every pitch you write will be an octave out.

The representable range is `C-1` (MIDI 0) to `G9` (MIDI 127). The grammar
admits a few names outside it (`A9`, `Cb-1`); those parse but are rejected as
`note.pitch-out-of-range`. Enharmonic spellings are equivalent — `A#1` and
`Bb1` are both MIDI 34 — and `fmt` keeps whichever you wrote while sorting by
the MIDI number. Unrelated field, easily confused: a drumkit's `<voice>.pitch`
(§6) is an integer cents offset for a sample, not a note name.

### 5.2 `fmt` owns the whole file

`musictool fmt` is not a steps-string formatter; it rewrites every file of a
valid project to canonical bytes, so any part of a file you hand-format may
come back changed. What it normalises:

- Layout: 2-space indent, one object key per line, arrays whose elements are
  all primitives on one line (`"timeSignature": [4, 4]`, each automation
  `[tick, value]` pair), trailing newline. A compact one-line note or clip
  object is reflowed to one key per line.
- Key order: a fixed order per document kind (for a note event, `pitch`,
  `startTick`, `durationTicks`, `velocity`, `microTicks`, `probability`,
  `ratchet`), with keys the order doesn't name sorted alphabetically. The
  open-ended maps — instrument `params` and `kit` — are sorted alphabetically.
- Number spelling: integers only, so `3840.0` is written `3840` and `-0` is
  `0`.
- Sort order: `notes` by `startTick`, then pitch as a MIDI number, then
  `durationTicks`; `clips` by `startTick`, then `track`; `stepEvents` by
  `step`.
- Steps strings: blocks of four (or the largest divisor of `stepsPerBar` that
  is ≤4, or ungrouped if none), ` | ` between bars.

What it does not reorder: `lanes` within a pattern, `patterns` within a track,
`trackOrder`, automation `lanes`, and automation `points` (whose order is
semantic — they must be strictly increasing in tick). It never changes a value:
no transposition, no requantisation, no re-spelling of enharmonics.

`fmt` never changes how a project sounds. Nothing it normalises reaches the
render — not layout, not key order, and not the sort order of `clips`, `notes`,
or `stepEvents`, since none of those array positions feed `probability`
resolution (§5). A render taken before `fmt` and one taken after are
byte-identical for the same seed, so analysis numbers verified before
formatting still hold after it.

`fmt` refuses to run on a project with validation errors — fix `validate`
first. `fmt --check` writes nothing, exits 1 if any file would change, and
names the aspects it can attribute per file — `formatting` (whitespace,
indentation, number spelling), `key order`, `sort order`, `steps grouping` — so
a reordering is distinguishable from a layout rewrite. `fmt` itself prints the
same aspects for each file it rewrote. It always writes the whole file, so
clearing the named aspect can still leave a `formatting` difference behind.

## 6. Instruments and the parameter registry

Every built-in engine (`basic-mono`, `basic-poly`, `drumkit`) declares a
fixed set of valid `params` keys, each with a unit, range/enum, default, and
whether it's automatable. `validate` checks every `params` entry and every
automation target against this registry; an unknown key gets a "did you
mean" suggestion instead of silently passing.

Every `params` value is an integer in the unit given below, except `enum`
params, which are one of the listed strings. Omitting a param means its
default; `fmt` never writes defaults in for you. Ranges are inclusive, and a
value outside one is `registry.invalid-value` (`registry.out-of-range` for an
automation point).

Shared subtractive params, valid on both `basic-mono` and `basic-poly`:

| param | unit | range / values | default | automatable |
|---|---|---|---|---|
| `oscillator` | enum | `sine`, `triangle`, `sawtooth`, `square` | `sawtooth` | no |
| `detune` | cents | −1200..1200 | 0 | yes |
| `filter.type` | enum | `lowpass`, `highpass`, `bandpass` | `lowpass` | no |
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

`drumkit` params are namespaced per kit voice, `<voice>.<param>`, where
`<voice>` must be a key in the instrument's `kit` map (`kick.gain`, not
`kik.gain`). There are no kit-wide drumkit params: everything is per voice.

| param | unit | range | default | automatable |
|---|---|---|---|---|
| `<voice>.gain` | dB×100 | −6000..600 | 0 | yes |
| `<voice>.pan` | permille | −1000..1000 | 0 | yes |
| `<voice>.pitch` | cents | −2400..2400 | 0 | no |
| `<voice>.chokeGroup` | count | 0..16 | 0 (none) | no |

Envelope note, since the numbers alone don't say it: `amp.attack`,
`amp.decay`, `amp.sustain`, and `amp.release` are a standard ADSR in the units
above, and none of the four is automatable — they are fixed per instrument, so
a passage that needs a different envelope needs a second instrument. The
release starts when the note ends (`startTick + durationTicks`) and runs for
`amp.release` on top of it, so with the defaults (`decay` 100 ms, `sustain`
900, `release` 1000 ms) a voice takes a further second to fall silent. On
`basic-poly` that means notes overlap, up to `maxVoices`; `basic-mono` has one
voice, so the next note takes it over and the tail is only heard in gaps. A
part that rings into itself or sounds more legato than written is this
envelope, not the notes: shorten `amp.release`, and `amp.decay` with a lower
`amp.sustain` if the body should fall away too.

Two more registry rules. An automation lane may only target a param with
`automatable: yes` (`automation.param-not-automatable`), and its values are in
the param's own unit — a `filter.cutoff` lane stores integer Hz, not permille.
The registry is closed: no other keys are valid, and an unknown one is
`registry.unknown-param` with a "did you mean" suggestion (§9).

## 7. Arrangement and automation

`arrangement.json` holds only the timeline: `lengthTicks` and `clips`
(`track`, `pattern`, `startTick`, `repeatCount`). A clip's `startTick +
repeatCount * pattern.lengthTicks` must not exceed `lengthTicks`.

`clips` is a set, not a sequence. A clip's index in the array places nothing:
timing comes from `startTick`, routing from `track`, and the renderer sorts
every scheduled event by position before rendering. Nothing at all is derived
from the position — not even `probability` resolution, which hashes the clip's
`startTick` and never its index (§5) — so `fmt` sorting the array by `startTick`
then `track`, or your inserting a clip anywhere in it, cannot change the music.
Two renders of two clip orderings are byte-identical, with no need to run `fmt`
first. Canonical order is not even a total order: two clips at the same
`startTick` on the same track tie, so array position is not a well-defined
property of a project and cannot be part of anything the audio depends on. Such
a pair is an exact duplicate — same events, same ticks, and now the same
`probability` outcomes, so both fire or both drop, and a hit that fires twice at
one tick is simply one louder hit (`describe` is what catches that, not the
render).

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

Those constraints are on samples going in. What comes out is unrelated to them:
`render` always writes 24-bit stereo PCM WAV at the requested `--sample-rate`
(default 48000), for the master and for every `--stems` file, whatever depth,
channel count, or rate the input samples had. Decode the output as 24-bit.

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
