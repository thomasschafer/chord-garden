import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readRegularFile } from "./readFile.js";
import type { Diagnostic, DiagnosticCollector, Loc, Severity, Span } from "./diagnostics.js";
import { locOfOffset, stringValueOffsets } from "./jsonParse.js";
import { EFFECTS_MIN_FORMAT } from "./formatVersion.js";
import type { LoadedFile } from "./loadProject.js";
import type {
  GridPatternDoc,
  InstrumentDoc,
  NotesPatternDoc,
  PatternDoc,
  Project,
  TrackDoc,
} from "./model.js";
import { EXPRESSION_FIELDS } from "./expression.js";
import { gridStepOffsetTicks, ticksPerBar } from "./musicTime.js";
import { parseSteps } from "./pattern.js";
import { pitchToMidi } from "./pitch.js";
import {
  checkParamValue,
  parseEffectParamKey,
  resolveEffectParam,
  resolveParam,
  resolveTrackParam,
  validEffectParamKeys,
  validParamKeys,
  validTrackParamKeys,
} from "./registry.js";
import { sampleReferences } from "./samples.js";
import { closestMatch } from "./util.js";
import { checkWavHeader } from "./wav.js";

export const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;

/**
 * Cross-file semantic rules (PLAN §8.1). Runs only after every file parsed
 * and passed schema validation, so documents can be trusted to have the right
 * shape.
 */
export function semanticValidate(
  project: Project,
  files: Map<string, LoadedFile>,
  diags: DiagnosticCollector,
): void {
  const report = (
    severity: Severity,
    code: string,
    file: string,
    pointer: string,
    message: string,
    suggestion?: string,
    span?: Span,
  ): void => {
    const loaded = files.get(file);
    const locs = loaded?.locs;
    // A span is in file coordinates and names the exact characters at fault, so
    // it also decides the line and column: the pointer only reaches the whole
    // value, and "the string on line 5" is a worse answer than "column 14 of it"
    // whenever the caller knew the column.
    const loc: Loc =
      span !== undefined && loaded !== undefined
        ? locOfOffset(loaded.text, span.start)
        : (locs?.get(pointer) ?? locs?.get("") ?? { line: 1, column: 1 });
    const diagnostic: Diagnostic = { severity, code, file, pointer, message, loc };
    if (span !== undefined) diagnostic.span = span;
    diags.add(suggestion === undefined ? diagnostic : { ...diagnostic, suggestion });
  };

  /**
   * Move a span from a decoded string value's own coordinates into the file's.
   *
   * `parseSteps` counts characters of the steps string; a diagnostic's `span`
   * counts bytes of the document. Forwarding one as the other would put a
   * plausible-looking offset into the wrong coordinate system, which is worse
   * than the `undefined` this returns when the string cannot be located.
   */
  const spanInFile = (file: string, pointer: string, span: Span | undefined): Span | undefined => {
    if (span === undefined) return undefined;
    const loaded = files.get(file);
    const loc = loaded?.locs.get(pointer);
    if (loaded === undefined || loc === undefined) return undefined;
    const offsets = stringValueOffsets(loaded.text, loc);
    const start = offsets?.[span.start];
    const end = offsets?.[span.end];
    return start === undefined || end === undefined ? undefined : { start, end };
  };

  const barTicks = checkTempoAndMeter(project, report);
  const trackFileOf = (id: string): string => `tracks/${id}.json`;

  checkTrackOrder(project, report);

  const referencedPatterns = new Set<string>();
  const referencedInstruments = new Set<string>();

  /**
   * A pattern is used by a track through two independent references — the
   * track's own `patterns` list and an `arrangement` clip — and both have to be
   * judged the same way, because the *renderer* only ever sees the clip. A
   * pairing checked here but not there is a project that validates and then
   * fails to render; the reverse is a project that renders and is refused.
   *
   * Only the kit check is deduplicated: it reports into the pattern file at a
   * pointer that does not mention the reference, so the same pairing reached
   * twice would produce two byte-identical diagnostics. A kind mismatch names
   * the reference itself, so every reference that is wrong is worth saying.
   */
  const kitCheckedPairings = new Set<string>();
  const checkPatternPairing = (track: TrackDoc, pattern: PatternDoc, file: string, pointer: string): void => {
    const expectedKind = track.type === "drumkit" ? "grid" : "notes";
    if (pattern.kind !== expectedKind) {
      report(
        "error",
        "track.pattern-kind-mismatch",
        file,
        pointer,
        `track "${track.id}" (type "${track.type}") may only use "${expectedKind}" patterns, but "${pattern.id}" is a "${pattern.kind}" pattern`,
      );
    }
    const instrument = project.instruments.get(track.instrument);
    if (pattern.kind !== "grid" || instrument?.type !== "drumkit") return;
    const pairing = `${track.id} ${pattern.id}`;
    if (kitCheckedPairings.has(pairing)) return;
    kitCheckedPairings.add(pairing);
    checkGridLanesAgainstKit(track, pattern, instrument.kit, report);
  };

  // Clip references are collected before the orphan sweep below: a pattern a
  // clip plays is in use, whatever any track's `patterns` list says.
  for (const clip of project.arrangement.clips) {
    referencedPatterns.add(clip.pattern);
  }

  for (const track of project.tracks.values()) {
    const file = trackFileOf(track.id);
    checkEffects(project, track, file, report);
    const instrument = project.instruments.get(track.instrument);
    referencedInstruments.add(track.instrument);
    if (instrument === undefined) {
      report(
        "error",
        "ref.missing-instrument",
        file,
        "/instrument",
        `track "${track.id}" references instrument "${track.instrument}" but instruments/${track.instrument}.json does not exist`,
        didYouMean(track.instrument, project.instruments.keys()),
      );
    } else {
      const expectedType = track.type === "drumkit" ? "drumkit" : "synth";
      if (instrument.type !== expectedType) {
        report(
          "error",
          "track.instrument-type-mismatch",
          file,
          "/instrument",
          `track "${track.id}" has type "${track.type}" but instrument "${instrument.id}" has type "${instrument.type}"`,
        );
      }
    }

    track.patterns.forEach((patternId, i) => {
      referencedPatterns.add(patternId);
      const pattern = project.patterns.get(patternId);
      if (pattern === undefined) {
        report(
          "error",
          "ref.missing-pattern",
          file,
          `/patterns/${i}`,
          `track "${track.id}" references pattern "${patternId}" but patterns/${patternId}.json does not exist`,
          didYouMean(patternId, project.patterns.keys()),
        );
        return;
      }
      checkPatternPairing(track, pattern, file, `/patterns/${i}`);
    });
  }

  for (const pattern of project.patterns.values()) {
    const file = `patterns/${pattern.id}.json`;
    if (pattern.kind === "grid") {
      checkGridPattern(pattern, file, barTicks, report, spanInFile);
    } else {
      checkNotesPattern(pattern, file, report);
    }
    if (!referencedPatterns.has(pattern.id)) {
      report("warning", "orphan.pattern", file, "", `pattern "${pattern.id}" is not referenced by any track`);
    }
  }

  for (const instrument of project.instruments.values()) {
    const file = `instruments/${instrument.id}.json`;
    checkInstrumentParams(instrument, file, report);
    if (!referencedInstruments.has(instrument.id)) {
      report(
        "warning",
        "orphan.instrument",
        file,
        "",
        `instrument "${instrument.id}" is not referenced by any track`,
      );
    }
  }

  checkArrangement(project, report, checkPatternPairing);
  checkEventsReachTimeline(project, barTicks, report);
  checkAutomation(project, report);
  checkSamples(project, report);
}

type Report = (
  severity: Severity,
  code: string,
  file: string,
  pointer: string,
  message: string,
  suggestion?: string,
  /** File-coordinate span of the exact characters at fault, when known. */
  span?: Span,
) => void;

/**
 * Translates a span expressed in a string value's own characters into the file
 * coordinates every diagnostic locator uses. Returns `undefined` when the
 * string cannot be located, rather than guessing.
 */
type SpanInFile = (file: string, pointer: string, span: Span | undefined) => Span | undefined;

function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  const match = closestMatch(name, candidates);
  return match === undefined ? undefined : `did you mean "${match}"?`;
}

/** Returns ticks per bar, or undefined when the meter itself is invalid. */
function checkTempoAndMeter(project: Project, report: Report): number | undefined {
  const { tempoMap, meterMap, ppqn } = project.project;
  if (tempoMap.length !== 1) {
    report(
      "error",
      "project.tempo-map-size",
      "project.json",
      "/tempoMap",
      `v1 supports exactly one tempo point, found ${tempoMap.length}`,
    );
  }
  if (tempoMap[0] !== undefined && tempoMap[0].startTick !== 0) {
    report("error", "project.tempo-map-start", "project.json", "/tempoMap/0/startTick", "the first tempo point must start at tick 0");
  }
  if (meterMap.length !== 1) {
    report(
      "error",
      "project.meter-map-size",
      "project.json",
      "/meterMap",
      `v1 supports exactly one meter point, found ${meterMap.length}`,
    );
  }
  const meter = meterMap[0];
  if (meter === undefined) return undefined;
  if (meter.startTick !== 0) {
    report("error", "project.meter-map-start", "project.json", "/meterMap/0/startTick", "the first meter point must start at tick 0");
  }
  const barTicks = ticksPerBar(ppqn, meter.timeSignature);
  if (!Number.isInteger(barTicks)) {
    report(
      "error",
      "project.meter-ticks-not-integer",
      "project.json",
      "/meterMap/0/timeSignature",
      `ppqn ${ppqn} with time signature ${meter.timeSignature[0]}/${meter.timeSignature[1]} yields a non-integer bar length (${barTicks} ticks)`,
    );
    return undefined;
  }
  return barTicks;
}

function checkTrackOrder(project: Project, report: Report): void {
  const seen = new Set<string>();
  project.project.trackOrder.forEach((id, i) => {
    if (seen.has(id)) {
      report("error", "trackorder.duplicate", "project.json", `/trackOrder/${i}`, `track "${id}" appears more than once in trackOrder`);
    }
    seen.add(id);
    if (!project.tracks.has(id)) {
      report(
        "error",
        "trackorder.unknown-track",
        "project.json",
        `/trackOrder/${i}`,
        `trackOrder lists "${id}" but tracks/${id}.json does not exist`,
        didYouMean(id, project.tracks.keys()),
      );
    }
  });
  const clipCounts = new Map<string, number>();
  for (const clip of project.arrangement.clips) {
    clipCounts.set(clip.track, (clipCounts.get(clip.track) ?? 0) + 1);
  }

  for (const id of project.tracks.keys()) {
    if (seen.has(id)) continue;
    const clips = clipCounts.get(id) ?? 0;
    if (clips === 0) {
      // Nothing plays on it, so leaving it out of `trackOrder` costs no music.
      // PLAN.md §8.1 calls this an orphan, warning for now.
      report(
        "warning",
        "orphan.track",
        `tracks/${id}.json`,
        "",
        `track "${id}" is not listed in project.json trackOrder`,
        `add "${id}" to trackOrder`,
      );
      continue;
    }
    // With clips it is a different mistake entirely. `compile` walks
    // `trackOrder`, so this track and every clip on it are dropped from the
    // render — the whole part gone, with a `warnings: none` report to say so.
    // The document is self-inconsistent: `arrangement.json` schedules music on a
    // track that `project.json` does not place, and there is no render setting
    // under which both statements can hold. That makes it an error rather than a
    // louder warning; a warning is for something an author might have meant, and
    // nobody means "play this part, but not really".
    report(
      "error",
      "trackorder.missing-track",
      "project.json",
      "/trackOrder",
      `track "${id}" has ${clips} clip${clips === 1 ? "" : "s"} in arrangement.json but is not listed in project.json trackOrder, so nothing on it would be rendered`,
      `add "${id}" to trackOrder`,
    );
  }
}

function checkGridLanesAgainstKit(
  track: TrackDoc,
  pattern: GridPatternDoc,
  kit: Record<string, { sample: string }>,
  report: Report,
): void {
  pattern.lanes.forEach((lane, i) => {
    // `Object.hasOwn`, not `in`: a lane named `constructor` is a lane name like
    // any other, and `in` would say the kit has it.
    if (!Object.hasOwn(kit, lane.lane)) {
      report(
        "error",
        "pattern.lane-unknown-voice",
        `patterns/${pattern.id}.json`,
        `/lanes/${i}/lane`,
        `lane "${lane.lane}" does not exist in the kit of instrument "${track.instrument}" (used by track "${track.id}")`,
        didYouMean(lane.lane, Object.keys(kit)),
      );
    }
  });
}

function checkGridPattern(
  pattern: GridPatternDoc,
  file: string,
  barTicks: number | undefined,
  report: Report,
  spanInFile: SpanInFile,
): void {
  if (barTicks === undefined) return;
  if (pattern.lengthTicks % barTicks !== 0) {
    report(
      "error",
      "pattern.length-not-bar-multiple",
      file,
      "/lengthTicks",
      `grid pattern length ${pattern.lengthTicks} is not a multiple of one bar (${barTicks} ticks)`,
    );
    return;
  }
  const bars = pattern.lengthTicks / barTicks;

  /**
   * Two lanes naming one voice is a silent wrong-audio case, not a tidiness
   * complaint. A lane is a voice seen from the pattern side (§5), so both lanes
   * schedule onto the same drumkit voice and every step they share fires twice
   * — one hit at twice the amplitude, which reads as a mix problem rather than
   * as a pattern that says the same thing twice. Probability cannot separate
   * them either: the identity a hit is rolled from is its lane name and step, so
   * duplicates roll identically and both fire or both drop.
   */
  const seenLanes = new Set<string>();
  pattern.lanes.forEach((lane, i) => {
    if (seenLanes.has(lane.lane)) {
      report(
        "error",
        "pattern.duplicate-lane",
        file,
        `/lanes/${i}/lane`,
        `more than one lane plays voice "${lane.lane}"; both would fire on every step they share, at twice the level`,
        "merge the two lanes into one, or rename one to another voice in the kit",
      );
    }
    seenLanes.add(lane.lane);

    const stepsPointer = `/lanes/${i}/steps`;
    const { stepsPerBar } = lane.grid;
    if (barTicks % stepsPerBar !== 0) {
      report(
        "error",
        "pattern.grid-not-divisible",
        file,
        `/lanes/${i}/grid/stepsPerBar`,
        `stepsPerBar ${stepsPerBar} does not divide one bar (${barTicks} ticks) into integer ticks`,
      );
      return;
    }
    const parsed = parseSteps(lane.steps, { file, pointer: stepsPointer, stepsPerBar, bars });
    for (const d of parsed.diagnostics) {
      // `parseSteps` computed the exact column in the steps string; translated
      // here rather than dropped, so a locator that knows which character is
      // wrong reaches the caller instead of pointing at the whole string.
      const pointer = d.pointer ?? stepsPointer;
      report(d.severity, d.code, d.file, pointer, d.message, d.suggestion, spanInFile(d.file, pointer, d.span));
    }
    if (parsed.hits === undefined) return;

    const hitSet = new Set(parsed.hits);
    const totalSteps = stepsPerBar * bars;
    const seenSteps = new Set<number>();
    lane.stepEvents?.forEach((event, j) => {
      const pointer = `/lanes/${i}/stepEvents/${j}/step`;
      if (event.step >= totalSteps) {
        report("error", "pattern.step-event-out-of-range", file, pointer, `step ${event.step} is outside the pattern (${totalSteps} steps)`);
        return;
      }
      if (seenSteps.has(event.step)) {
        report("error", "pattern.step-event-duplicate", file, pointer, `more than one stepEvent targets step ${event.step}`);
      }
      seenSteps.add(event.step);
      if (!hitSet.has(event.step)) {
        report(
          "error",
          "pattern.step-event-not-a-hit",
          file,
          pointer,
          `stepEvent targets step ${event.step} but that step is a rest (\`.\`); stepEvents may only target \`x\` steps`,
        );
      }
    });
  });
}

function checkNotesPattern(pattern: NotesPatternDoc, file: string, report: Report): void {
  pattern.notes.forEach((note, i) => {
    if (note.startTick >= pattern.lengthTicks) {
      report(
        "error",
        "note.start-out-of-range",
        file,
        `/notes/${i}/startTick`,
        `note starts at tick ${note.startTick} but the pattern is ${pattern.lengthTicks} ticks long`,
      );
    }
    const midi = pitchToMidi(note.pitch);
    if (midi === undefined || midi < 0 || midi > 127) {
      report("error", "note.pitch-out-of-range", file, `/notes/${i}/pitch`, `pitch "${note.pitch}" is outside the MIDI range C-1..G9`);
    }
  });
}

/**
 * A track's effect chain: the version gate, id uniqueness, and every param.
 *
 * Ids must be unique *within the chain* and nowhere wider, because `fx.<id>` is
 * resolved against one track's chain. That is the whole reason the chain is
 * addressed by id at all: two tracks may both have a `room`, and reordering
 * either one re-targets nothing.
 */
function checkEffects(project: Project, track: TrackDoc, file: string, report: Report): void {
  const effects = track.effects;
  if (effects === undefined) return;
  if (project.project.format < EFFECTS_MIN_FORMAT) {
    report(
      "error",
      "format.effects-require-2",
      file,
      "/effects",
      `track "${track.id}" has an effects chain, which requires project.json "format": ${EFFECTS_MIN_FORMAT}, but this project declares format ${project.project.format}`,
      `set "format" to ${EFFECTS_MIN_FORMAT} in project.json, or remove the "effects" chain`,
    );
    // Reporting each effect's params against a version that does not have
    // effects would be a page of consequences of one mistake.
    return;
  }

  const seen = new Set<string>();
  effects.forEach((effect, index) => {
    const pointer = `/effects/${index}`;
    if (seen.has(effect.id)) {
      report(
        "error",
        "effect.duplicate-id",
        file,
        `${pointer}/id`,
        `track "${track.id}" has more than one effect with id "${effect.id}"; automation addresses an effect by id, so ids must be unique within a chain`,
      );
    }
    seen.add(effect.id);

    for (const [param, value] of Object.entries(effect.params ?? {})) {
      const paramPointer = `${pointer}/params/${escapeSegment(param)}`;
      const spec = resolveEffectParam(effect.type, param);
      if (spec === undefined) {
        report(
          "error",
          "registry.unknown-param",
          file,
          paramPointer,
          `unknown param "${param}" for a "${effect.type}" effect`,
          didYouMean(param, validEffectParamKeys(effect.type)),
        );
        continue;
      }
      const problem = checkParamValue(spec, value);
      if (problem !== undefined) {
        report(
          "error",
          "registry.invalid-value",
          file,
          paramPointer,
          `param "${param}" of effect "${effect.id}" value ${JSON.stringify(value)} is invalid: ${problem} (unit: ${spec.unit})`,
        );
      }
    }
  });
}

function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function checkInstrumentParams(instrument: InstrumentDoc, file: string, report: Report): void {
  const params = instrument.params;
  if (params === undefined) return;
  for (const [key, value] of Object.entries(params)) {
    const pointer = `/params/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const resolved = resolveParam(instrument, key);
    if (resolved === undefined) {
      report(
        "error",
        "registry.unknown-param",
        file,
        pointer,
        `unknown param "${key}" for ${describeEngine(instrument)}`,
        didYouMean(key, validParamKeys(instrument)),
      );
      continue;
    }
    const problem = checkParamValue(resolved.spec, value);
    if (problem !== undefined) {
      report("error", "registry.invalid-value", file, pointer, `param "${key}" value ${JSON.stringify(value)} is invalid: ${problem} (unit: ${resolved.spec.unit})`);
    }
  }
}

function describeEngine(instrument: { type: string; engine?: string }): string {
  return instrument.type === "synth" ? `engine "${instrument.engine}"` : "a drumkit instrument";
}

/** Judges one track's use of one pattern; see `checkPatternPairing`. */
type CheckPatternPairing = (track: TrackDoc, pattern: PatternDoc, file: string, pointer: string) => void;

function checkArrangement(project: Project, report: Report, checkPatternPairing: CheckPatternPairing): void {
  const file = "arrangement.json";
  project.arrangement.clips.forEach((clip, i) => {
    const track = project.tracks.get(clip.track);
    if (track === undefined) {
      report(
        "error",
        "ref.missing-track",
        file,
        `/clips/${i}/track`,
        `clip references track "${clip.track}" but tracks/${clip.track}.json does not exist`,
        didYouMean(clip.track, project.tracks.keys()),
      );
    }
    const pattern = project.patterns.get(clip.pattern);
    if (pattern === undefined) {
      report(
        "error",
        "ref.missing-pattern",
        file,
        `/clips/${i}/pattern`,
        `clip references pattern "${clip.pattern}" but patterns/${clip.pattern}.json does not exist`,
        didYouMean(clip.pattern, project.patterns.keys()),
      );
      return;
    }
    // The renderer compiles a clip's pattern against the clip's track, so the
    // pairing has to hold here exactly as it does on `track.patterns`.
    if (track !== undefined) checkPatternPairing(track, pattern, file, `/clips/${i}/pattern`);
    const end = clip.startTick + clip.repeatCount * pattern.lengthTicks;
    if (end > project.arrangement.lengthTicks) {
      report(
        "error",
        "clip.out-of-range",
        file,
        `/clips/${i}`,
        `clip ends at tick ${end} which is past the arrangement length ${project.arrangement.lengthTicks}`,
      );
    }
  });
}

/** The earliest tick a pattern's events reach, relative to a repetition start. */
interface EarliestEvent {
  offsetTicks: number;
  /** What to call the event in a diagnostic. */
  description: string;
}

/**
 * A negative `microTicks` can nudge an event before its pattern, which is
 * musically ordinary — a hit that lands slightly early — and is exactly what the
 * field is for. It only becomes a problem when the clip sits at the very start
 * of the arrangement, because then the event lands before tick 0 and the
 * compiler drops it (`emitRatchets` refuses `start.tick < rangeStartTick`) with
 * nothing said.
 *
 * So the rule is deliberately about the *clip*, not the pattern: the same
 * pattern placed at bar 2 is fine and must keep validating. Reported as an error
 * rather than a warning because no seed, `--bars` range or sample rate can make
 * the event sound — the document is asking for a position the timeline does not
 * have.
 */
function checkEventsReachTimeline(project: Project, barTicks: number | undefined, report: Report): void {
  if (barTicks === undefined) return;
  const file = "arrangement.json";
  project.arrangement.clips.forEach((clip, i) => {
    const pattern = project.patterns.get(clip.pattern);
    if (pattern === undefined) return; // already reported as ref.missing-pattern
    const earliest = earliestEvent(pattern, barTicks, project.project.swing);
    if (earliest === undefined) return;
    // Repetitions only ever start later, so the first one bounds the clip.
    const tick = clip.startTick + earliest.offsetTicks;
    if (tick >= 0) return;
    report(
      "error",
      "event.before-timeline-start",
      file,
      `/clips/${i}`,
      `${earliest.description} in pattern "${pattern.id}" lands at tick ${tick} when the clip starts at tick ${clip.startTick}, which is before the start of the arrangement, so it cannot sound`,
      `move the clip later or raise the event's microTicks`,
    );
  });
}

/**
 * The earliest position any of a pattern's events reaches, or undefined when the
 * pattern has no events or is already malformed in a way another rule reports.
 */
function earliestEvent(pattern: PatternDoc, barTicks: number, projectSwing: number): EarliestEvent | undefined {
  const defaultMicroTicks = EXPRESSION_FIELDS.microTicks.default;
  let earliest: EarliestEvent | undefined;
  const consider = (offsetTicks: number, description: string): void => {
    if (earliest === undefined || offsetTicks < earliest.offsetTicks) earliest = { offsetTicks, description };
  };

  if (pattern.kind === "notes") {
    for (const note of pattern.notes) {
      consider(note.startTick + (note.microTicks ?? defaultMicroTicks), `note "${note.pitch}" at tick ${note.startTick}`);
    }
    return earliest;
  }

  const bars = pattern.lengthTicks / barTicks;
  if (!Number.isInteger(bars)) return undefined; // pattern.length-not-bar-multiple
  pattern.lanes.forEach((lane, laneIndex) => {
    const { stepsPerBar } = lane.grid;
    if (barTicks % stepsPerBar !== 0) return; // pattern.grid-not-divisible
    const stepTicks = barTicks / stepsPerBar;
    const parsed = parseSteps(lane.steps, {
      file: `patterns/${pattern.id}.json`,
      pointer: `/lanes/${laneIndex}/steps`,
      stepsPerBar,
      bars,
    });
    if (parsed.hits === undefined) return; // the parse diagnostics say why
    const microByStep = new Map((lane.stepEvents ?? []).map((event) => [event.step, event.microTicks]));
    const swing = lane.defaults?.swing ?? projectSwing;
    for (const step of parsed.hits) {
      const microTicks = microByStep.get(step) ?? defaultMicroTicks;
      consider(
        gridStepOffsetTicks(step, stepTicks, swing, microTicks),
        `step ${step} of lane "${lane.lane}"`,
      );
    }
  });
  return earliest;
}

function checkAutomation(project: Project, report: Report): void {
  for (const automation of project.automation.values()) {
    const file = `automation/${automation.track}.json`;
    const track = project.tracks.get(automation.track);
    if (track === undefined) {
      report(
        "error",
        "automation.unknown-track",
        file,
        "/track",
        `automation targets track "${automation.track}" but tracks/${automation.track}.json does not exist`,
        didYouMean(automation.track, project.tracks.keys()),
      );
      continue;
    }
    const instrument = project.instruments.get(track.instrument);
    if (instrument === undefined) continue; // already reported as ref.missing-instrument

    const seenParams = new Set<string>();
    automation.lanes.forEach((lane, i) => {
      const lanePointer = `/lanes/${i}`;
      if (seenParams.has(lane.param)) {
        report("error", "automation.duplicate-lane", file, `${lanePointer}/param`, `more than one automation lane targets param "${lane.param}"`);
      }
      seenParams.add(lane.param);

      // Resolved against the track, not just its instrument: a lane may target an
      // effect param as `fx.<id>.<param>`, and the chain is the track's.
      const resolved = resolveTrackParam(instrument, track.effects, lane.param);
      if (resolved === undefined) {
        const parsed = parseEffectParamKey(lane.param);
        const unknownEffect =
          parsed !== undefined && !(track.effects ?? []).some((effect) => effect.id === parsed.effectId);
        if (unknownEffect) {
          report(
            "error",
            "ref.missing-effect",
            file,
            `${lanePointer}/param`,
            `automation targets effect "${parsed.effectId}" but track "${track.id}" has no effect with that id`,
            didYouMean(parsed.effectId, (track.effects ?? []).map((effect) => effect.id)),
          );
          return;
        }
        report(
          "error",
          "registry.unknown-param",
          file,
          `${lanePointer}/param`,
          `unknown param "${lane.param}" for ${describeEngine(instrument)} on track "${track.id}"`,
          didYouMean(lane.param, validTrackParamKeys(instrument, track.effects)),
        );
        return;
      }
      if (!resolved.spec.automatable) {
        report(
          "error",
          "automation.param-not-automatable",
          file,
          `${lanePointer}/param`,
          `param "${lane.param}" is not automatable`,
        );
        return;
      }

      let previousTick = -1;
      lane.points.forEach((point, j) => {
        const [tick, value] = point;
        if (tick <= previousTick) {
          report(
            "error",
            "automation.points-not-increasing",
            file,
            `${lanePointer}/points/${j}`,
            `point tick ${tick} is not strictly greater than the previous point (${previousTick})`,
          );
        }
        previousTick = tick;
        if (tick > project.arrangement.lengthTicks) {
          report(
            "error",
            "automation.point-out-of-range",
            file,
            `${lanePointer}/points/${j}`,
            `point tick ${tick} is past the arrangement length ${project.arrangement.lengthTicks}`,
          );
        }
        const problem = checkParamValue(resolved.spec, value);
        if (problem !== undefined) {
          report(
            "error",
            "registry.out-of-range",
            file,
            `${lanePointer}/points/${j}`,
            `automation value ${value} for "${lane.param}" is invalid: ${problem} (unit: ${resolved.spec.unit})`,
          );
        }
      });
    });
  }
}

function checkSamples(project: Project, report: Report): void {
  const referenced = new Map<string, { file: string; pointer: string }>();

  // The enumeration is shared with the sidecar's sample watcher, so the set of
  // files checked here is exactly the set watched for replacement.
  for (const { path: sample, file, pointer } of sampleReferences(project)) {
    if (isAbsolute(sample) || sample.split("/").includes("..")) {
      report("error", "sample.path-invalid", file, pointer, `sample path "${sample}" must be project-relative (no absolute paths, no "..")`);
      continue;
    }
    if (!sample.startsWith("samples/")) {
      report("error", "sample.path-invalid", file, pointer, `sample path "${sample}" must live under samples/`);
      continue;
    }
    if (!sample.endsWith(".wav")) {
      report("error", "sample.not-wav", file, pointer, `sample "${sample}" must be an uncompressed PCM .wav file in v1`);
      continue;
    }
    referenced.set(sample, { file, pointer });

    // Same rule as a project document: read it as a regular file within the cap
    // or refuse it. A FIFO named `samples/kick.wav` passed the old `statSync`
    // with size 0 and then blocked the read forever.
    const read = readRegularFile(join(project.root, sample), MAX_SAMPLE_BYTES);
    if (!read.ok) {
      const { refusal } = read;
      if (refusal.reason === "missing") {
        report("error", "sample.missing", file, pointer, `sample file "${sample}" does not exist on disk`);
      } else if (refusal.reason === "not-regular") {
        report("error", "sample.not-a-file", file, pointer, `sample "${sample}" is ${refusal.description}; a sample must be a regular file`);
      } else {
        report(
          "error",
          "sample.oversize",
          file,
          pointer,
          `sample "${sample}" is ${refusal.size} bytes; the per-sample cap is ${MAX_SAMPLE_BYTES}`,
        );
      }
      continue;
    }
    const header = checkWavHeader(read.bytes);
    if (!header.ok) {
      report("error", "sample.not-wav", file, pointer, `sample "${sample}" is not a valid PCM WAV file: ${header.reason}`);
    }
  }

  let sampleFiles: string[];
  try {
    sampleFiles = readdirSync(join(project.root, "samples"));
  } catch {
    return;
  }
  for (const name of sampleFiles.sort()) {
    if (name.startsWith(".")) continue;
    const path = `samples/${name}`;
    if (!referenced.has(path)) {
      report("warning", "orphan.sample", path, "", `sample file "${path}" is not referenced by any instrument`);
    }
  }
}

