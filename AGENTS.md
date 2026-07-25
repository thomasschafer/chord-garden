# Agent guide

This project's source of truth is a directory of JSON files (a "project
bundle"), not a database or a running app. You edit those files directly
with your normal file tools — there is no special agent API. Read
`docs/format-spec.md` before editing a project; it's the format reference.
This file is the workflow: how to make an edit safely and check your work.

## The loop

There is no way to "hear" your edit by reading JSON. Use this loop every
time:

1. **Edit** the relevant file(s) directly.
2. `musictool validate <project>` — catches malformed JSON, schema
   violations, and semantic errors (bad references, wrong step counts,
   invalid engine params, etc.). Fix everything reported as `error` before
   moving on; `warning` (e.g. an orphaned pattern) is worth a second look but
   doesn't block you.
3. `musictool describe <project> --json` — confirms the project now
   contains what you think it contains (track list, pattern bar counts, hit
   counts per lane, note counts and pitch range).
4. `musictool render <project> --analyze` — the real check. It writes
   `render/master.wav` and `render/analysis.json` by default, then prints a
   short summary. Use `--json` for the full report. Read `warnings` first,
   then check master/track `peakDb`, `rmsDb`, and `clipping`; a track with
   scheduled events must not be `silent`, `onsets.matched` should equal
   `onsets.expected`, and `onsets.spurious` should be inspected. A silent
   track with zero `eventCount` is normal.
   `validate` only proves the JSON is well-formed; this proves the result
   actually made sound at the scheduled positions. `musictool render --help`
   lists the flags and what each analysis field means.

   A drumkit track's numbers are its whole kit mixed together, and coincident
   hits collapse into one onset — a kick landing on a hat adds no distinct
   expected onset, so the kick can be nearly invisible in the track's counts.
   Each drumkit track therefore also carries `voices`: one entry per kit voice,
   with its own `eventCount`, `peakDb`, `silent`, and `onsets`, measured by
   running the same detector over that voice's own audio. A voice is the kit
   entry and the pattern lane that drives it under one name
   (`docs/format-spec.md` §6), so checking one lane of a drum pattern means
   reading its voice here — "the kick lands on every beat" is that voice's
   `onsets`, with no `--stems` and no copy of the project with the other lanes
   deleted. Every `onsets` object lists the scheduled sample positions in
   `expectedPositions`, and the report's `musicalGrid` gives `barPositions` and
   `beatPositions` for the rendered range, so checking alignment is comparing
   two lists rather than doing arithmetic over tempo and ppqn. A voice with
   scheduled events that renders silent is warned about by name.

Don't consider an edit done until `validate` passes with no errors. Read
`musictool validate <project>` output for `error`-severity `code` values —
they're stable identifiers, not prose to parse loosely.

Three things about the render that look like bugs and aren't:

- **The output is 24-bit stereo PCM WAV**, at `--sample-rate` (default 48000),
  for the master and for each `--stems` file, whatever bit depth, channel count,
  or rate the input samples have. Decoding it as 16-bit gives noise, not audio.
  `--stems` writes `stems/<track>.wav` for every track and, for a drumkit track,
  also `stems/<track>.<voice>.wav` per kit voice; the per-voice files sum back to
  their track's stem to within 24-bit rounding, since each file is quantised on
  its own.
- **`onsets.expected` already accounts for `probability`.** It counts the
  distinct sample positions of the events the compiler actually scheduled —
  after probability was resolved, with coincident events collapsed to one. A
  pattern holding 18 notes, one of them at `probability: 800`, legitimately
  reports `17 events, onsets 17/17`. That is a pass; don't go hunting for the
  missing note. The real failure is `matched` below `expected`, and
  `unmatchedExpected` lists the positions that produced no sound. Collapsing is
  also why a drumkit track's onset counts sit below its `eventCount` — the
  worked example's `drums` reports `239 events, onsets 191/191` — while a voice
  collapses only against itself, so a voice's `expected` is its own hits.
- **`--seed` changes which probabilistic events fire.** It defaults to 0, so a
  render is reproducible, but event and onset counts move with the seed. Keep
  one seed while iterating, and don't read a count change after a seed change as
  a regression. The seed is the only thing that moves outcomes wholesale: no
  array position feeds the hash, so inserting, removing, or reordering clips or
  notes (or running `fmt`) leaves every other event's outcome, and every other
  track's counts, identical (`docs/format-spec.md` §5). Moving a clip to a
  different `startTick` re-rolls that clip's own probabilistic events only, and
  editing a note's `startTick`, pitch, or `durationTicks` re-rolls that note
  only.

## Editing rules

- **Strict JSON only.** No comments (`//`, `/* */`), no trailing commas.
  Comments in a file will fail with `json.comment` and tell you to use a
  `description` field instead — that's not a bug, it's why the format has no
  comment-preservation logic to get wrong.
- **Every number is an integer in a fixed unit** — permille, ms, Hz, cents,
  dB×100, bpm×100, or ticks (see `docs/format-spec.md` §2). Never write
  `0.8` where a permille integer (`800`) is expected, and never write a
  fractional tempo like `124.5` — it's `12450` in bpm×100. The rule covers
  numbers; a few fields are strings, `pitch` above all (see below).
- **IDs match file names.** `patterns/bass-main.json` must contain `"id":
  "bass-main"`. Automation files use `"track"` instead of `"id"`.
- **One file, one concern.** Editing the hi-hat pattern means touching only
  `patterns/<that-pattern>.json` — not `arrangement.json`, not other
  patterns. Small, surgical diffs are the point of the directory-per-object
  layout.
- **Don't hand-format anything; `fmt` owns file layout.** `musictool fmt
  <project>` rewrites whole files, not just `steps` strings: indentation, key
  order, the grouping of a steps string, and the order of `notes`, `clips`, and
  `stepEvents` (rules in `docs/format-spec.md` §5.2). So write content in
  whatever shape is convenient and let `fmt` settle it — and don't be alarmed
  when its diff touches lines you didn't edit. **`fmt` never changes how a
  project sounds.** The order of `clips`, `notes`, and `stepEvents` reaches
  nothing at all — not timing, pitch, level, or duration, and not even which
  `probability` events fire (§5 and §7) — so a render before `fmt` and a render
  after it are byte-identical for the same seed, and analysis numbers you
  verified before formatting still hold.
  `musictool fmt <project> --check` writes nothing, exits 1 if
  anything would change, and names which aspect (formatting, key order, sort
  order, steps grouping) per file.
- **Engine params are a closed registry**, not open JSON. If `validate`
  reports `registry.unknown-param`, check the suggested "did you mean" — a
  typo like `fitler.cutoff` is the most common mistake. Every valid key with its
  unit, range, default, and whether it can be automated is in
  `docs/format-spec.md` §6.
- **Note pitches are strings, not MIDI numbers.** `"pitch": "A1"`, never
  `"pitch": 33`. Middle C is `C4` (MIDI 60) and `A1` is 55 Hz — see
  `docs/format-spec.md` §5.1 before writing pitches, since guessing the octave
  numbering is how a part ends up an octave out.
- **Samples are project-relative**, under `samples/`, referenced as
  `samples/<name>.wav`. Never an absolute path, never `..`.
- **Never bump `project.json.format`.** A newer format than the tool
  supports is rejected outright, not migrated. If you think the format
  itself needs to change, that's a format-spec change, not a project edit —
  flag it rather than doing it unilaterally.

## Common mistakes (and their diagnostic codes)

| mistake | you'll see |
|---|---|
| wrong number of steps in a lane | `pattern.step-count-mismatch` (message says how many to add/remove) |
| `stepEvents` step index points at a rest, not a hit | `pattern.step-event-not-a-hit` |
| used `X` for an accent | `pattern.accent-unsupported` — use `x` + `velocity` in `stepEvents` |
| lane name isn't a voice in the instrument's `kit` | `pattern.lane-unknown-voice` (with a suggestion) |
| misspelled a note name (`bb2`, `Ab#1`) | `schema.pattern` on `/notes/<i>/pitch` — the grammar is `docs/format-spec.md` §5.1 |
| wrote a pitch as a MIDI number (`33`) | `schema.type` — pitch is a string |
| note name parses but is outside MIDI 0..127 | `note.pitch-out-of-range` |
| typo'd an engine param name | `registry.unknown-param` (with a suggestion) |
| automated a non-automatable param | `automation.param-not-automatable` |
| referenced a pattern/track/instrument that doesn't exist | `ref.missing-*` (with a suggestion) |
| file's `id` doesn't match its filename | `id.file-mismatch` |
| wrote a float where an integer-unit value belongs | `number.float` |
| left a `//` comment in a JSON file | `json.comment` |

## What you never need to do

There is no agent-specific integration to wire up. You edit files with
`Read`/`Write`/`Edit`; if the desktop UI has the project open, a file watcher
(Phase 4) picks up your changes and reconciles them automatically. You don't
call an API, don't need a special mode, and don't coordinate with the UI
beyond making sure `validate` passes before you consider the edit finished.
