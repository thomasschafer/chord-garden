// The pure entry, not the package root: the root reaches `node:fs` through
// `loadProject`, and this module has to bundle for the browser (see the format
// package's `pure.ts`).
import {
  parseSteps,
  pitchToMidi,
  resolveParam,
  ticksPerBar,
  type AutomationLane,
  type GridPatternDoc,
  type InstrumentDoc,
  type NotesPatternDoc,
  type PatternDoc,
  type Project,
  type TrackDoc,
} from "@chord-garden/format/pure";

export interface CompileOptions {
  /** Defaults to 48000. */
  sampleRate: number;
  /** Defaults to 0. */
  seed: number;
  /** Optional bar range [startBar, endBar) to compile; omit for the whole arrangement. */
  barRange?: { start: number; end: number };
}

export interface CompiledNoteEvent {
  /** Sample offset from the start of the compiled range. Always >= 0. */
  startSample: number;
  durationSamples: number;
  /** MIDI note number 0..127. */
  midi: number;
  /** permille 0..1000, as persisted. */
  velocity: number;
  /** For drumkit tracks, the kit voice this event triggers. Absent for synth tracks. */
  voice?: string;
}

export interface CompiledAutomationLane {
  param: string;
  /** Sampled to a step-wise-constant array, one value per control block. */
  interp: "linear" | "step";
  /** Breakpoints as [sampleOffset, value] in the param's registry unit. */
  points: [number, number][];
}

export interface CompiledTrack {
  trackId: string;
  instrumentId: string;
  /** Sorted by startSample, then midi. */
  events: CompiledNoteEvent[];
  automation: CompiledAutomationLane[];
}

export interface CompiledSchedule {
  sampleRate: number;
  seed: number;
  totalSamples: number;
  tracks: CompiledTrack[]; // in project.trackOrder order
}

/**
 * Bar and beat boundaries of a compiled range, in samples from the start of the
 * range. Boundaries use the same tick-to-sample rounding as events, so an event
 * scheduled on a beat carries exactly that beat's sample position and alignment
 * can be checked by comparison rather than arithmetic.
 *
 * V1 reads `tempoMap[0]` and `meterMap[0]` only (see `compile`), so the grid is
 * uniform across the range.
 */
export interface MusicalGrid {
  /** Zero-based bar number of the first bar in the range: the `--bars` start. */
  startBar: number;
  beatsPerBar: number;
  /** One entry per bar starting inside the range; `[0]` is 0 when non-empty. */
  barStarts: number[];
  /** One entry per beat starting inside the range; `[0]` is 0 when non-empty. */
  beatStarts: number[];
}

interface CompileContext {
  project: Project;
  sampleRate: number;
  seed: number;
  samplesPerTick: number;
  barTicks: number;
  beatsPerBar: number;
  rangeStartTick: number;
  rangeEndTick: number;
  totalSamples: number;
}

/**
 * The per-event key that seeds probability resolution. Every component is a
 * musical coordinate; no array position appears anywhere, on purpose.
 *
 * The clip contributes its `startTick` rather than its index in
 * `arrangement.clips`: `clips` is a set, so array position is not a property
 * of the music, and canonical order (startTick, then track) does not even
 * totally order it. Keying on the index made inserting or reordering any clip
 * re-roll which events fire on every *other* clip and track, which breaks the
 * guarantee that one edit changes one thing (PLAN.md §13). `startTick` is a
 * musical position, so moving a clip re-rolls only that clip's own events.
 *
 * A note contributes its own coordinates for the same reason (see
 * `PatternEventKey`): `notes` is a set too, and `fmt` sorts it.
 */
interface EventIdentity {
  trackId: string;
  patternId: string;
  clipStartTick: number;
  repeatIndex: number;
  event: PatternEventKey;
}

/**
 * Which event *within* a pattern is rolling. The obvious key — the event's
 * index in its array — is wrong for `notes`, and the trap is worth naming:
 * `fmt` sorts `notes` into canonical order, so an index-keyed identity let a
 * format run silently change which probabilistic notes fire, i.e. change the
 * music an agent had already verified. `startTick` + `midi` + `durationTicks`
 * is exactly the canonical sort key (see `canonicalFiles`), so two notes
 * collide in the identity only when canonical order ties them — in which case
 * array position is not a well-defined property of the project and cannot be
 * keyed on at all. Such a pair rolls together, which is what near-duplicates
 * at one position and pitch should do (docs/format-spec.md §5).
 *
 * `pitch` enters as its MIDI number, not its spelling, so respelling `A#1` as
 * `Bb1` cannot re-roll a note.
 *
 * Grid lanes keep their `step`, which is already a musical position within the
 * bar rather than an array position, and is stable under every `fmt` rule
 * (`steps` regrouping and `stepEvents` sorting both preserve step numbers).
 */
type PatternEventKey =
  | { kind: "step"; laneName: string; step: number }
  | { kind: "note"; startTick: number; midi: number; durationTicks: number };

export function compile(project: Project, options: Partial<CompileOptions> = {}): CompiledSchedule {
  const context = compileContext(project, options);
  const tracks = context.project.project.trackOrder.map((trackId) => compileTrack(context, trackId));
  return {
    sampleRate: context.sampleRate,
    seed: context.seed,
    totalSamples: context.totalSamples,
    tracks,
  };
}

/**
 * The bar and beat grid of the range `compile` would produce for the same
 * options. Kept beside the compiler so both speak one tick-to-sample rule.
 */
export function musicalGrid(project: Project, options: Partial<CompileOptions> = {}): MusicalGrid {
  const context = compileContext(project, options);
  const beatTicks = context.barTicks / context.beatsPerBar;
  return {
    startBar: context.rangeStartTick / context.barTicks,
    beatsPerBar: context.beatsPerBar,
    barStarts: gridStarts(context, context.barTicks),
    beatStarts: gridStarts(context, beatTicks),
  };
}

/** Sample positions of every `stepTicks` boundary starting inside the range. */
function gridStarts(context: CompileContext, stepTicks: number): number[] {
  const starts: number[] = [];
  if (stepTicks <= 0) throw new Error(`cannot build musical grid: step of ${stepTicks} ticks is not positive`);
  for (let index = 0; ; index++) {
    // Multiplied rather than accumulated so a fractional step cannot drift.
    const tick = context.rangeStartTick + index * stepTicks;
    if (tick >= context.rangeEndTick) return starts;
    starts.push(tickToSample(tick - context.rangeStartTick, context.samplesPerTick));
  }
}

function compileContext(project: Project, options: Partial<CompileOptions>): CompileContext {
  const sampleRate = options.sampleRate ?? 48_000;
  const seed = options.seed ?? 0;
  checkOptions(sampleRate, seed, options.barRange);

  const tempo = project.project.tempoMap[0];
  if (tempo === undefined) throw new Error("cannot compile project: tempoMap has no first point");
  const meter = project.project.meterMap[0];
  if (meter === undefined) throw new Error("cannot compile project: meterMap has no first point");

  const barTicks = ticksPerBar(project.project.ppqn, meter.timeSignature);
  if (!Number.isInteger(barTicks)) {
    throw new Error(`cannot compile project: meterMap[0] produces a non-integer bar length (${barTicks} ticks)`);
  }
  const samplesPerTick = (60 / (tempo.bpm / 100) / project.project.ppqn) * sampleRate;
  const rangeStartTick = options.barRange === undefined ? 0 : options.barRange.start * barTicks;
  const rangeEndTick = options.barRange === undefined ? project.arrangement.lengthTicks : options.barRange.end * barTicks;
  if (rangeEndTick > project.arrangement.lengthTicks) {
    throw new Error(
      `cannot compile bar range: end tick ${rangeEndTick} is past arrangement length ${project.arrangement.lengthTicks}`,
    );
  }

  for (const [clipIndex, clip] of project.arrangement.clips.entries()) {
    if (!project.tracks.has(clip.track)) {
      throw new Error(`cannot compile clip ${clipIndex}: track "${clip.track}" does not exist`);
    }
    if (!project.patterns.has(clip.pattern)) {
      throw new Error(`cannot compile clip ${clipIndex}: pattern "${clip.pattern}" does not exist`);
    }
  }

  return {
    project,
    sampleRate,
    seed,
    samplesPerTick,
    barTicks,
    beatsPerBar: meter.timeSignature[0],
    rangeStartTick,
    rangeEndTick,
    totalSamples: tickToSample(rangeEndTick - rangeStartTick, samplesPerTick),
  };
}

function checkOptions(
  sampleRate: number,
  seed: number,
  barRange: { start: number; end: number } | undefined,
): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`cannot compile project: sampleRate must be a positive integer, got ${sampleRate}`);
  }
  if (!Number.isFinite(seed)) throw new Error(`cannot compile project: seed must be finite, got ${seed}`);
  if (barRange === undefined) return;
  if (!Number.isInteger(barRange.start) || !Number.isInteger(barRange.end)) {
    throw new Error("cannot compile bar range: start and end must be integer bar numbers");
  }
  if (barRange.start < 0 || barRange.end < barRange.start) {
    throw new Error(`cannot compile bar range [${barRange.start}, ${barRange.end}): expected 0 <= start <= end`);
  }
}

function compileTrack(context: CompileContext, trackId: string): CompiledTrack {
  const track = context.project.tracks.get(trackId);
  if (track === undefined) throw new Error(`cannot compile track "${trackId}": track does not exist`);
  const instrument = context.project.instruments.get(track.instrument);
  if (instrument === undefined) {
    throw new Error(`cannot compile track "${trackId}": instrument "${track.instrument}" does not exist`);
  }
  const expectedInstrumentType = track.type === "drumkit" ? "drumkit" : "synth";
  if (instrument.type !== expectedInstrumentType) {
    throw new Error(
      `cannot compile track "${trackId}": expected a ${expectedInstrumentType} instrument, got "${instrument.type}"`,
    );
  }

  const events: CompiledNoteEvent[] = [];
  context.project.arrangement.clips.forEach((clip, clipIndex) => {
    if (clip.track !== trackId) return;
    const pattern = context.project.patterns.get(clip.pattern);
    if (pattern === undefined) {
      throw new Error(`cannot compile clip ${clipIndex} on track "${trackId}": pattern "${clip.pattern}" does not exist`);
    }
    checkPatternKind(track, pattern);
    for (let repeatIndex = 0; repeatIndex < clip.repeatCount; repeatIndex++) {
      const repetitionStartTick = clip.startTick + repeatIndex * pattern.lengthTicks;
      if (pattern.kind === "grid") {
        compileGridPattern(context, track, instrument, pattern, clip.startTick, repeatIndex, repetitionStartTick, events);
      } else {
        compileNotesPattern(context, track, pattern, clip.startTick, repeatIndex, repetitionStartTick, events);
      }
    }
  });

  events.sort(compareEvents);
  return {
    trackId,
    instrumentId: instrument.id,
    events,
    automation: compileAutomation(context, track, instrument),
  };
}

function checkPatternKind(track: TrackDoc, pattern: PatternDoc): void {
  const expected = track.type === "drumkit" ? "grid" : "notes";
  if (pattern.kind !== expected) {
    throw new Error(
      `cannot compile pattern "${pattern.id}" on track "${track.id}": expected kind "${expected}", got "${pattern.kind}"`,
    );
  }
}

function compileGridPattern(
  context: CompileContext,
  track: TrackDoc,
  instrument: InstrumentDoc,
  pattern: GridPatternDoc,
  clipStartTick: number,
  repeatIndex: number,
  repetitionStartTick: number,
  output: CompiledNoteEvent[],
): void {
  if (instrument.type !== "drumkit") {
    throw new Error(`cannot compile grid pattern "${pattern.id}": instrument "${instrument.id}" is not a drumkit`);
  }
  const bars = pattern.lengthTicks / context.barTicks;
  if (!Number.isInteger(bars)) {
    throw new Error(`cannot compile grid pattern "${pattern.id}": length is not a whole number of bars`);
  }

  pattern.lanes.forEach((lane, laneIndex) => {
    if (!(lane.lane in instrument.kit)) {
      throw new Error(
        `cannot compile lane "${lane.lane}" in pattern "${pattern.id}": voice does not exist in drumkit "${instrument.id}"`,
      );
    }
    const parsed = parseSteps(lane.steps, {
      file: `patterns/${pattern.id}.json`,
      pointer: `/lanes/${laneIndex}/steps`,
      stepsPerBar: lane.grid.stepsPerBar,
      bars,
    });
    if (parsed.hits === undefined) {
      const details = parsed.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
      throw new Error(`cannot compile lane "${lane.lane}" in pattern "${pattern.id}": ${details}`);
    }

    const stepTicks = context.barTicks / lane.grid.stepsPerBar;
    if (!Number.isInteger(stepTicks)) {
      throw new Error(
        `cannot compile lane "${lane.lane}" in pattern "${pattern.id}": ${lane.grid.stepsPerBar} steps do not divide a bar`,
      );
    }
    const eventsByStep = new Map(lane.stepEvents?.map((event) => [event.step, event]) ?? []);
    const swing = lane.defaults?.swing ?? context.project.project.swing;

    for (const step of parsed.hits) {
      const stepEvent = eventsByStep.get(step);
      const swingTicks = step % 2 === 1 ? Math.round((swing * stepTicks) / 2000) : 0;
      const startTick = repetitionStartTick + step * stepTicks + swingTicks + (stepEvent?.microTicks ?? 0);
      const gateTicks = stepEvent?.gateTicks ?? lane.defaults?.gateTicks ?? stepTicks;
      const probability = stepEvent?.probability ?? lane.defaults?.probability ?? 1000;
      const identity: EventIdentity = {
        trackId: track.id,
        patternId: pattern.id,
        clipStartTick,
        repeatIndex,
        event: { kind: "step", laneName: lane.lane, step },
      };
      if (!fires(context.seed, identity, probability)) continue;
      emitRatchets(
        context,
        startTick,
        gateTicks,
        stepEvent?.ratchet ?? 1,
        60,
        stepEvent?.velocity ?? lane.defaults?.velocity ?? 800,
        lane.lane,
        output,
      );
    }
  });
}

function compileNotesPattern(
  context: CompileContext,
  track: TrackDoc,
  pattern: NotesPatternDoc,
  clipStartTick: number,
  repeatIndex: number,
  repetitionStartTick: number,
  output: CompiledNoteEvent[],
): void {
  pattern.notes.forEach((note, noteIndex) => {
    const midi = pitchToMidi(note.pitch);
    if (midi === undefined || midi < 0 || midi > 127) {
      throw new Error(`cannot compile note ${noteIndex} in pattern "${pattern.id}": pitch "${note.pitch}" is invalid`);
    }
    const identity: EventIdentity = {
      trackId: track.id,
      patternId: pattern.id,
      clipStartTick,
      repeatIndex,
      event: {
        kind: "note",
        startTick: note.startTick,
        midi,
        durationTicks: note.durationTicks,
      },
    };
    if (!fires(context.seed, identity, note.probability ?? 1000)) return;
    emitRatchets(
      context,
      repetitionStartTick + note.startTick + (note.microTicks ?? 0),
      note.durationTicks,
      note.ratchet ?? 1,
      midi,
      note.velocity,
      undefined,
      output,
    );
  });
}

function emitRatchets(
  context: CompileContext,
  startTick: number,
  gateTicks: number,
  ratchet: number,
  midi: number,
  velocity: number,
  voice: string | undefined,
  output: CompiledNoteEvent[],
): void {
  const boundaries = Array.from({ length: ratchet + 1 }, (_, index) => {
    const tick = startTick + (gateTicks * index) / ratchet;
    return {
      tick,
      sample: tickToSample(tick - context.rangeStartTick, context.samplesPerTick),
    };
  });

  for (let index = 0; index < ratchet; index++) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    // V1 does not carry notes that began before the compiled range into it.
    if (start.tick < context.rangeStartTick || start.tick >= context.rangeEndTick) continue;
    const event = {
      startSample: start.sample,
      durationSamples: end.sample - start.sample,
      midi,
      velocity,
    };
    output.push(voice === undefined ? event : { ...event, voice });
  }
}

function fires(seed: number, identity: EventIdentity, probability: number): boolean {
  if (probability === 1000) return true;
  if (probability === 0) return false;
  const where = [seed, identity.trackId, identity.patternId, identity.clipStartTick, identity.repeatIndex];
  const event = identity.event;
  const key = JSON.stringify(
    event.kind === "step"
      ? [...where, event.laneName, event.step]
      : [...where, event.startTick, event.midi, event.durationTicks],
  );
  return fnv1a(key) / 0x1_0000_0000 < probability / 1000;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function compileAutomation(
  context: CompileContext,
  track: TrackDoc,
  instrument: InstrumentDoc,
): CompiledAutomationLane[] {
  const automation = context.project.automation.get(track.id);
  if (automation === undefined) return [];
  if (automation.track !== track.id) {
    throw new Error(`cannot compile automation for track "${track.id}": document targets "${automation.track}"`);
  }
  return automation.lanes.map((lane) => {
    const resolved = resolveParam(instrument, lane.param);
    if (resolved === undefined) {
      throw new Error(`cannot compile automation for track "${track.id}": param "${lane.param}" does not exist`);
    }
    if (!resolved.spec.automatable) {
      throw new Error(`cannot compile automation for track "${track.id}": param "${lane.param}" is not automatable`);
    }
    return {
      param: lane.param,
      interp: lane.interp,
      points: clipAutomationPoints(context, lane),
    };
  });
}

function clipAutomationPoints(context: CompileContext, lane: AutomationLane): [number, number][] {
  const output: [number, number][] = [];
  const startValue = automationValueAt(lane, context.rangeStartTick);
  if (startValue !== undefined) appendAutomationPoint(output, 0, startValue);

  for (const [tick, value] of lane.points) {
    if (tick > context.rangeStartTick && tick < context.rangeEndTick) {
      appendAutomationPoint(output, tickToSample(tick - context.rangeStartTick, context.samplesPerTick), value);
    }
  }

  if (context.rangeEndTick > context.rangeStartTick) {
    const endValue = automationValueAt(lane, context.rangeEndTick);
    if (endValue !== undefined) appendAutomationPoint(output, context.totalSamples, endValue);
  }
  return output;
}

function appendAutomationPoint(output: [number, number][], sample: number, value: number): void {
  const last = output.at(-1);
  if (last?.[0] === sample) {
    output[output.length - 1] = [sample, value];
  } else {
    output.push([sample, value]);
  }
}

function automationValueAt(lane: AutomationLane, tick: number): number | undefined {
  const first = lane.points[0];
  if (first === undefined || tick < first[0]) return undefined;

  let previous = first;
  for (let index = 1; index < lane.points.length; index++) {
    const next = lane.points[index]!;
    if (tick === next[0]) return next[1];
    if (tick < next[0]) {
      if (lane.interp === "step") return previous[1];
      const progress = (tick - previous[0]) / (next[0] - previous[0]);
      return Math.round(previous[1] + (next[1] - previous[1]) * progress);
    }
    previous = next;
  }
  return previous[1];
}

function tickToSample(tick: number, samplesPerTick: number): number {
  return Math.round(tick * samplesPerTick);
}

function compareEvents(left: CompiledNoteEvent, right: CompiledNoteEvent): number {
  if (left.startSample !== right.startSample) return left.startSample - right.startSample;
  if (left.midi !== right.midi) return left.midi - right.midi;
  const leftVoice = left.voice ?? "";
  const rightVoice = right.voice ?? "";
  return leftVoice < rightVoice ? -1 : leftVoice > rightVoice ? 1 : 0;
}
