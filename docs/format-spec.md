# Project format spec (v1)

This is the authoritative reference for the on-disk project format. It is
generated from and must stay consistent with `PLAN.md` Part One; if they
disagree, treat that as a bug and fix the mismatch. Agents editing a project
should read this file and `AGENTS.md` before making changes. This file is
self-sufficient: it defers nothing to `PLAN.md`, so everything needed to write
a valid project — including the required and optional fields of every document
(§1.1) and the full parameter registry (§6) — is here.

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

### 1.1 Required and optional fields

Every object in this format is closed, so the tables below are a complete
inventory: a field that is required and absent is `schema.required`, and a
field that appears in neither column is `schema.unevaluatedProperties` — there
is no third category of tolerated extra key. What the fields *mean*, and the
unit each number is in, is the rest of this document; this section is only
their shape. `description` is optional on every document that has one and is
never read by the tool.

Rows name an object by a dotted path from its document kind, where `[]` is an
element of an array and `[*]` is a value in an open map. These are the same
paths canonical key order is defined over (§5.2).

`project.json`:

| object | required | optional |
|---|---|---|
| `project` | `format`, `name`, `ppqn`, `tempoMap`, `meterMap`, `swing`, `trackOrder` | `description`, `key` |
| `project.tempoMap[]` | `startTick`, `bpm` | (none) |
| `project.meterMap[]` | `startTick`, `timeSignature` | (none) |
| `project.key` | `root`, `scale` | (none) |

Two of those catch people out. `name` is required and has no default — a
project without one does not validate. And `swing` is required even though 0 is
the neutral value: it is a project-wide timing law (§4), so it is written
rather than inferred, and a project that means straight time says `"swing": 0`.

`tracks/<id>.json`:

| object | required | optional |
|---|---|---|
| `track` | `id`, `type`, `instrument`, `patterns` | `description`, `effects` |
| `track.effects[]` | `id`, `type` | `description`, `params` |

`instruments/<id>.json`, in its two kinds:

| object | required | optional |
|---|---|---|
| `instrument.synth` | `id`, `type`, `engine` | `description`, `params` |
| `instrument.drumkit` | `id`, `type`, `kit` | `description`, `params` |
| `instrument.drumkit.kit[*]` | `sample` | (none) |

`patterns/<id>.json`, in its two kinds:

| object | required | optional |
|---|---|---|
| `pattern.grid` | `id`, `kind`, `lengthTicks`, `lanes` | `description` |
| `pattern.grid.lanes[]` | `lane`, `grid`, `steps` | `defaults`, `stepEvents` |
| `pattern.grid.lanes[].grid` | `stepsPerBar` | (none) |
| `pattern.grid.lanes[].defaults` | (none) | `velocity`, `gateTicks`, `probability`, `swing` |
| `pattern.grid.lanes[].stepEvents[]` | `step` | `velocity`, `microTicks`, `gateTicks`, `probability`, `ratchet` |
| `pattern.notes` | `id`, `kind`, `lengthTicks`, `notes` | `description` |
| `pattern.notes.notes[]` | `pitch`, `startTick`, `durationTicks`, `velocity` | `microTicks`, `probability`, `ratchet` |

`arrangement.json` and `automation/<track-id>.json`:

| object | required | optional |
|---|---|---|
| `arrangement` | `lengthTicks`, `clips` | `description` |
| `arrangement.clips[]` | `track`, `pattern`, `startTick`, `repeatCount` | (none) |
| `automation` | `track`, `lanes` | `description` |
| `automation.lanes[]` | `param`, `interp`, `points` | (none) |

Optional does not mean an empty one will do. Where a value carries no
information unless it holds something, the empty form is rejected rather than
ignored, so omitting it and writing it are not two spellings of one state. A
lane's `defaults` needs at least one key; a `stepEvents` entry needs at least
one key besides the `step` it targets, since an entry that only names a step
overrides nothing. Write no `defaults` rather than `{}`.

The same applies to six arrays, each the entire content of the thing holding
it: `project.tempoMap` and `project.meterMap` (v1 in fact requires exactly one
point in each, §3), a grid pattern's `lanes`, a lane's `stepEvents`, an
automation document's `lanes`, and a lane's `points`. Two arrays are fixed-arity
rather than merely non-empty: a `timeSignature` is exactly two integers, and an
automation point is exactly `[tick, value]`.

The arrays that may be empty are the ones whose emptiness is a real state you
can be partway through writing: a pattern's `notes`, an arrangement's `clips`, a
track's `patterns` and `effects`, and `trackOrder`.

`params` and `kit` are open maps rather than fixed objects, so they have no
column here. `kit` keys are voice names (§5, §6) and `params` keys come from the
registry (§6); both are closed against those, not against a list of fields. A
`kit` may not be empty either — a drumkit with no voices plays nothing.

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

**A permille that scales a signal is a linear amplitude coefficient** — never a
power, a decibel value, or a perceived-loudness curve. `velocity: 500` renders at
exactly half the amplitude of `velocity: 1000` (−6.02 dB), and `velocity: 0` is
exactly silent; `amp.sustain: 900` holds the envelope at 0.9 of its peak. This is
a decision rather than an inherited convention: MIDI implementations disagree
about whether velocity is amplitude or power, and this format settles it as
amplitude so that one unit means one thing everywhere. Levels wanting a
logarithmic response have a unit of their own — `gain` is dB×100 — and an author
wanting a steeper velocity response shapes it in the velocity values themselves
rather than in a hidden curve. The law is identical for a synth note's `velocity`
and a drum hit's, so the two instrument types answer the same edit the same way.

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

`project.json.swing` (permille) applies to every grid lane. It is required
rather than defaulted, so straight time is the written value 0 (§1.1). A lane
may override it with `defaults.swing`, which is optional and falls back to the
project's value when absent. Every odd-indexed step in a lane
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
instrument used by the track that plays this pattern (§6). In that map the same
name is a *voice*: lane and voice are one identifier seen from the pattern side
and the instrument side, and it is the voice that params, stems, and analysis
name (§6). A name that isn't a kit key is an error,
`pattern.lane-unknown-voice`, with a "did you mean" suggestion. The check runs
per track→pattern reference, so a pattern reached by two tracks is
checked against both kits, and a pattern no track references is not checked at
all (it is already reported as `orphan.pattern`).

One voice gets at most one lane in a pattern: two lanes naming the same voice is
`pattern.duplicate-lane`. A lane is a voice seen from the pattern side, so both
would schedule onto the same voice and every step they share would fire twice —
one hit at twice the level, which reads as a mix problem rather than as a pattern
that says the same thing twice. `probability` cannot separate them either, since
a grid hit's identity is its lane name and step (below): duplicate lanes roll
identically and both fire or both drop. Merge them, or rename one to another
voice in the kit.

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
`trackOrder`, automation `lanes`, automation `points` (whose order is semantic —
they must be strictly increasing in tick), and a track's `effects`, whose order
is the order audio passes through the chain. An effect's own `params` map is
sorted alphabetically like any other open map. It never changes a value: no
transposition, no requantisation, no re-spelling of enharmonics.

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
A voice is what a grid pattern's lane of the same name plays (§5): the lane holds
the hits, the voice makes the sound. The voice is therefore the unit a render can
isolate — `render --analyze` reports each voice's own level and onsets under its
track's `voices`, so one lane of a kit can be verified on its own audio, and
`--stems` writes it as `stems/<track>.<voice>.wav` (`musictool render --help`,
`AGENTS.md`).

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

### 6.1 Effects

A track may carry an `effects` chain, applied in array order after its
instrument. **This requires `format` 2** (§10); a format-1 track with `effects`
is `format.effects-require-2`.

```json
{
  "id": "bass",
  "type": "instrument",
  "instrument": "bass-synth",
  "patterns": ["bass-main"],
  "effects": [
    { "id": "tone", "type": "filter", "params": { "cutoff": 1400 } },
    { "id": "slap", "type": "delay", "params": { "feedback": 420, "time": 250 } }
  ]
}
```

Every effect carries its own `id` (kebab-case, `^[a-z][a-z0-9-]*$`), unique
within the track (`effect.duplicate-id`). Automation targets an effect param as
**`fx.<id>.<param>`** — the author's id, not the type, and never the array
position. Reordering a chain changes the order audio passes through it and
nothing else: no automation lane re-targets and no other effect's settings move.
That key is always exactly three segments, so it can never collide with a
drumkit's two-segment `<voice>.<param>` — even on a kit that happens to have a
voice named `fx`. An `fx.` key naming an effect the track does not have is
`ref.missing-effect`.

`params` follows the same rules as an instrument's: closed, registry-declared,
omitted keys take the default, and a param at its default is not written.

**delay** — a feedback line with a damped repeat.

| param | unit | range / values | default | automatable |
|---|---|---|---|---|
| `time` | ms | 1..2000 | 375 | no |
| `feedback` | permille | 0..950 | 300 | yes |
| `damping` | permille | 0..1000 | 300 | yes |
| `mix` | permille | 0..1000 | 250 | yes |

`time` is milliseconds, not a musical division: every *position* in this format
is ticks, but a device time constant is already ms here (`amp.attack`,
`portamento`), and a beat is `60000 / bpm` ms if you want one. It is the one
non-automatable numeric param in the set, because the tap is an integer offset
into a buffer — sweeping it would step rather than glide, so modulated delay is
deferred rather than faked (§11). `feedback` stops at 950 because unity never
decays; the bound is in the range rather than in a clamp you cannot see.
`damping` is what makes high feedback usable, since undamped repeats pile up
high frequencies and turn metallic.

**reverb** — eight damped combs into four allpasses per channel.

| param | unit | range / values | default | automatable |
|---|---|---|---|---|
| `size` | permille | 0..1000 | 500 | yes |
| `damping` | permille | 0..1000 | 500 | yes |
| `width` | permille | 0..1000 | 1000 | yes |
| `mix` | permille | 0..1000 | 200 | yes |

`size` maps to a recirculation gain strictly below 1, so stability is a property
of the mapping rather than of a limiter.

**filter** — the same biquad and Q mapping the synth voices use, so a track
sweep and an instrument sweep cannot sound like two different filters.

| param | unit | range / values | default | automatable |
|---|---|---|---|---|
| `mode` | enum | lowpass, highpass, bandpass | lowpass | no |
| `cutoff` | Hz | 20..20000 | 1000 | yes |
| `resonance` | permille | 0..1000 | 100 | yes |

It is `mode` rather than `type` because an effect already has a `type`, and
`{"type": "filter", "params": {"type": "lowpass"}}` is a sentence nobody should
have to read twice.

A reverb or a long delay keeps sounding after the last note. `render` does not
extend its buffer to fit that tail — `--tail` is what you asked for, so a tail
longer than it is reported as a truncation rather than silently changing the
length of your render (`AGENTS.md`).

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
from colliding with clip edits. Each lane names a `param`, an `interp`
(`linear` or `step`), and strictly-increasing `[tick, value]` points, value in
the param's unit. At most one lane per param per track.

A lane may target either a param on the track's **instrument** (`filter.cutoff`,
or `kick.gain` on a drumkit) or a param on one of its **effects**, written
`fx.<id>.<param>` (§6.1). Either way the param must be `automatable: yes`.

## 8. Samples

Samples live under `samples/`, referenced by project-relative path (e.g.
`samples/kick.wav`). Absolute paths and `..` are errors. v1 accepts
uncompressed PCM WAV only, validated by extension and header, with a 50 MB
per-file cap. A referenced sample that doesn't exist on disk is an error
naming the missing path.

Samples are identified by content, so replacing one in place is a real edit
even though no JSON changed: an app with the project open adopts the new audio
from the next hit onward without a reload, and hits already sounding play out
on the buffer they started with rather than clicking. A replacement that fails
the checks above behaves like any other invalid edit — the diagnostic names the
file and nothing is adopted until it validates again.

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

A diagnostic carries up to three locators, and they are not interchangeable.
`pointer` is a JSON Pointer into the document's model, so it survives `fmt` and
is the one to key tooling on. `loc` and `span` locate the same fault in the
file's *bytes* — a line and column, and a character range — so they move when
the file is reformatted, and they are always in file coordinates even when the
fault is a single character inside a string. A bad character in a steps string
is found at a column of that string and reported at its column in the file, so
an editor can underline the character itself rather than the whole value.

Effects add three codes: `format.effects-require-2` (a format-1 track carrying a
chain, §10), `effect.duplicate-id` (two effects on one track sharing an id, which
would make `fx.<id>.<param>` ambiguous), and `ref.missing-effect` (an `fx.` lane
naming an effect the track does not have, with a "did you mean").

## 10. Versioning

The current `format` is **2**. `validate` rejects a project whose `format` is
newer than the tool supports — it does not attempt to migrate. Breaking changes
bump `format`; additive non-breaking changes keep it the same but must still
round-trip through canonical formatting unchanged.

**Format 1 still reads.** Only a *newer* version is rejected, so every format-1
project remains valid and nothing needs migrating. The single thing version 2
adds is a track's `effects` chain (§6.1), so a format-1 track carrying `effects`
is an error (`format.effects-require-2`) naming the version it needs — and that
is the only complaint reported, rather than a page of consequences of one
mistake.

**Writing preserves the version a document already has.** A format-1 project
stays at 1 through any number of edits; the tool raises it to 2 only when you
add an effect chain, which is the point at which the document genuinely stops
being format 1. That bump is one visible line in `project.json`, written in the
same batch as the chain — `AGENTS.md` tells agents never to set `format`
themselves, so the tool doing it on their behalf has to be something they can
see in the diff rather than a number that quietly moved. Removing the last
effect does not walk the version back.

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
- Tempo-synced delay time, and modulated (swept) delay time. A moving tap needs
  a fractional read pointer and brings pitch artefacts with it; `time` is
  integer ms and non-automatable rather than pretending otherwise (§6.1).
- Nonlinear effects — distortion, saturation, compression. Every effect here is
  linear and time-invariant while its params hold still, which is a property the
  engine's tests rely on; adding a nonlinearity is a deliberate change, not a
  fourth entry in the same list.
- Sends and busses: an effect chain belongs to one track, and there is no shared
  reverb bus. A `mixerLane` for effect params is likewise not wired yet — a
  reverb's `mix` is edited in the effects section, not on a fader.
