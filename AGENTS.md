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
4. `musictool render <project> --analyze` (arrives in Phase 1) — the real
   check. `validate` only proves the JSON is well-formed; `render --analyze`
   proves the result actually sounds like what you intended (onsets land
   where the pattern says they should, tracks that should be audible aren't
   silent, nothing is clipping). Until `render` exists, `validate` +
   `describe` is the full loop — say so if asked to confirm something only
   audio can prove.

Don't consider an edit done until `validate` passes with no errors. Read
`musictool validate <project>` output for `error`-severity `code` values —
they're stable identifiers, not prose to parse loosely.

## Editing rules

- **Strict JSON only.** No comments (`//`, `/* */`), no trailing commas.
  Comments in a file will fail with `json.comment` and tell you to use a
  `description` field instead — that's not a bug, it's why the format has no
  comment-preservation logic to get wrong.
- **Every number is an integer in a fixed unit** — permille, ms, Hz, cents,
  dB×100, bpm×100, or ticks (see `docs/format-spec.md` §2). Never write
  `0.8` where a permille integer (`800`) is expected, and never write a
  fractional tempo like `124.5` — it's `12450` in bpm×100.
- **IDs match file names.** `patterns/bass-main.json` must contain `"id":
  "bass-main"`. Automation files use `"track"` instead of `"id"`.
- **One file, one concern.** Editing the hi-hat pattern means touching only
  `patterns/<that-pattern>.json` — not `arrangement.json`, not other
  patterns. Small, surgical diffs are the point of the directory-per-object
  layout.
- **Don't hand-format `steps` strings.** Write hits/rests in whatever spacing
  is convenient; run `musictool fmt <project>` to get the canonical grouping
  (blocks of four, `|` between bars). If you're checking whether a file is
  already canonical, `musictool fmt <project> --check` reports without
  writing.
- **Engine params are a closed registry**, not open JSON. If `validate`
  reports `registry.unknown-param`, check the suggested "did you mean" — a
  typo like `fitler.cutoff` is the most common mistake. The valid keys and
  their units/ranges are in `docs/format-spec.md` §6 and `PLAN.md` §6.2.
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
