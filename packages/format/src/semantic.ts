import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readRegularFile } from "./readFile.js";
import type { DiagnosticCollector, Loc, Severity } from "./diagnostics.js";
import { EFFECTS_MIN_FORMAT } from "./formatVersion.js";
import type { LoadedFile } from "./loadProject.js";
import type { GridPatternDoc, InstrumentDoc, NotesPatternDoc, Project, TrackDoc } from "./model.js";
import { ticksPerBar } from "./musicTime.js";
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
  ): void => {
    const locs = files.get(file)?.locs;
    const loc: Loc = locs?.get(pointer) ?? locs?.get("") ?? { line: 1, column: 1 };
    const diagnostic = { severity, code, file, pointer, message, loc };
    diags.add(suggestion === undefined ? diagnostic : { ...diagnostic, suggestion });
  };

  const barTicks = checkTempoAndMeter(project, report);
  const trackFileOf = (id: string): string => `tracks/${id}.json`;

  checkTrackOrder(project, report);

  const referencedPatterns = new Set<string>();
  const referencedInstruments = new Set<string>();

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
      const expectedKind = track.type === "drumkit" ? "grid" : "notes";
      if (pattern.kind !== expectedKind) {
        report(
          "error",
          "track.pattern-kind-mismatch",
          file,
          `/patterns/${i}`,
          `track "${track.id}" (type "${track.type}") may only use "${expectedKind}" patterns, but "${patternId}" is a "${pattern.kind}" pattern`,
        );
      }
      if (pattern.kind === "grid" && instrument?.type === "drumkit") {
        checkGridLanesAgainstKit(track, pattern, instrument.kit, report);
      }
    });
  }

  for (const pattern of project.patterns.values()) {
    const file = `patterns/${pattern.id}.json`;
    if (pattern.kind === "grid") {
      checkGridPattern(pattern, file, barTicks, report);
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

  checkArrangement(project, report);
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
) => void;

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
  for (const id of project.tracks.keys()) {
    if (!seen.has(id)) {
      report(
        "warning",
        "orphan.track",
        `tracks/${id}.json`,
        "",
        `track "${id}" is not listed in project.json trackOrder`,
        `add "${id}" to trackOrder`,
      );
    }
  }
}

function checkGridLanesAgainstKit(
  track: TrackDoc,
  pattern: GridPatternDoc,
  kit: Record<string, { sample: string }>,
  report: Report,
): void {
  pattern.lanes.forEach((lane, i) => {
    if (!(lane.lane in kit)) {
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

function checkGridPattern(pattern: GridPatternDoc, file: string, barTicks: number | undefined, report: Report): void {
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

  pattern.lanes.forEach((lane, i) => {
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
    for (const d of parsed.diagnostics) report(d.severity, d.code, d.file, d.pointer ?? stepsPointer, d.message, d.suggestion);
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

function checkArrangement(project: Project, report: Report): void {
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

