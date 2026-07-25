import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASIC_MONO_PARAMS,
  BASIC_POLY_PARAMS,
  DRUMKIT_VOICE_PARAMS,
  type DrumkitInstrumentDoc,
  type InstrumentDoc,
  type Project,
  type SynthInstrumentDoc,
} from "@chord-garden/format";
import { compile, type CompiledNoteEvent, type CompiledTrack } from "../compiler.js";
import {
  CONTROL_BLOCK_SIZE,
  DrumkitProcessor,
  createSynthProcessor,
  type DrumHitCommand,
  type DrumVoiceSettings,
  type NoteCommand,
  type ParamRamps,
  type SynthSettings,
} from "../dsp/index.js";
import { AutomationSet } from "./automation.js";
import { decodeWav } from "./wav.js";

export interface RenderOptions {
  sampleRate: number;
  seed: number;
  barRange?: { start: number; end: number };
  /** When true, also return per-track stems. */
  stems: boolean;
  /** Extra time rendered past the last event so releases/tails are not truncated. */
  tailSeconds: number;
}

export interface StereoAudio {
  /** Planar stereo: both arrays contain exactly totalSamples samples. */
  left: Float32Array;
  right: Float32Array;
}

export interface RenderedAudio {
  sampleRate: number;
  master: StereoAudio;
  stems?: Map<string, StereoAudio>;
  totalSamples: number;
}

export const DEFAULT_RENDER_OPTIONS: Readonly<RenderOptions> = {
  sampleRate: 48_000,
  seed: 0,
  stems: false,
  tailSeconds: 2,
};

export function render(project: Project, options: Partial<RenderOptions> = {}): RenderedAudio {
  const resolved = resolveOptions(options);
  const compileOptions =
    resolved.barRange === undefined
      ? { sampleRate: resolved.sampleRate, seed: resolved.seed }
      : { sampleRate: resolved.sampleRate, seed: resolved.seed, barRange: resolved.barRange };
  const schedule = compile(project, compileOptions);
  const totalSamples = schedule.totalSamples + Math.round(resolved.tailSeconds * resolved.sampleRate);
  const master: StereoAudio = {
    left: new Float32Array(totalSamples),
    right: new Float32Array(totalSamples),
  };
  const stems = resolved.stems ? new Map<string, StereoAudio>() : undefined;
  const sampleCache = new Map<string, ReturnType<typeof decodeWav>>();

  for (const compiledTrack of schedule.tracks) {
    const instrument = project.instruments.get(compiledTrack.instrumentId);
    if (instrument === undefined) throw new Error(`cannot render: instrument "${compiledTrack.instrumentId}" is missing`);
    const stem =
      instrument.type === "synth"
        ? renderSynthTrack(compiledTrack, instrument, totalSamples, resolved.sampleRate)
        : renderDrumTrack(project, compiledTrack, instrument, totalSamples, resolved.sampleRate, sampleCache);
    if (stems !== undefined) stems.set(compiledTrack.trackId, stem);
    // The float master deliberately remains unclipped so later analysis can
    // detect overloads. Integer WAV quantisation is where clamping occurs.
    for (let sample = 0; sample < totalSamples; sample++) {
      master.left[sample] = master.left[sample]! + stem.left[sample]!;
      master.right[sample] = master.right[sample]! + stem.right[sample]!;
    }
  }

  return stems === undefined
    ? { sampleRate: resolved.sampleRate, master, totalSamples }
    : { sampleRate: resolved.sampleRate, master, stems, totalSamples };
}

function resolveOptions(options: Partial<RenderOptions>): RenderOptions {
  const sampleRate = options.sampleRate ?? DEFAULT_RENDER_OPTIONS.sampleRate;
  const seed = options.seed ?? DEFAULT_RENDER_OPTIONS.seed;
  const stems = options.stems ?? DEFAULT_RENDER_OPTIONS.stems;
  const tailSeconds = options.tailSeconds ?? DEFAULT_RENDER_OPTIONS.tailSeconds;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("render sampleRate must be a positive integer");
  if (!Number.isFinite(seed)) throw new Error("render seed must be finite");
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0) throw new Error("render tailSeconds must be non-negative");
  return options.barRange === undefined
    ? { sampleRate, seed, stems, tailSeconds }
    : { sampleRate, seed, stems, tailSeconds, barRange: options.barRange };
}

function renderSynthTrack(
  track: CompiledTrack,
  instrument: SynthInstrumentDoc,
  totalSamples: number,
  sampleRate: number,
): StereoAudio {
  const settings = synthSettings(instrument);
  const processor = createSynthProcessor(instrument.engine, sampleRate, settings);
  const output = emptyStereo(totalSamples);
  const commands = synthCommands(track.events);
  const automation = new AutomationSet(track.automation);
  const staticValues = synthAutomationValues(settings);
  let commandIndex = 0;

  for (let blockStart = 0; blockStart < totalSamples; blockStart += CONTROL_BLOCK_SIZE) {
    const length = Math.min(CONTROL_BLOCK_SIZE, totalSamples - blockStart);
    const blockCommands: NoteCommand[] = [];
    while (commands[commandIndex] !== undefined && commands[commandIndex]!.sample < blockStart + length) {
      const command = commands[commandIndex]!;
      if (command.sample >= blockStart) blockCommands.push({ ...command.command, offset: command.sample - blockStart });
      commandIndex++;
    }
    const ramps = automation.ramps(Object.keys(staticValues), staticValues, blockStart, length);
    processIntoOutput(processor, output, blockStart, length, blockCommands, ramps);
  }
  return output;
}

function renderDrumTrack(
  project: Project,
  track: CompiledTrack,
  instrument: DrumkitInstrumentDoc,
  totalSamples: number,
  sampleRate: number,
  sampleCache: Map<string, ReturnType<typeof decodeWav>>,
): StereoAudio {
  const settings: Record<string, DrumVoiceSettings> = {};
  const staticValues: Record<string, number> = {};
  for (const [voice, kitVoice] of Object.entries(instrument.kit)) {
    let decoded = sampleCache.get(kitVoice.sample);
    if (decoded === undefined) {
      decoded = decodeWav(readFileSync(join(project.root, kitVoice.sample)));
      sampleCache.set(kitVoice.sample, decoded);
    }
    const params = instrument.params ?? {};
    const right = decoded.channels[1];
    settings[voice] = {
      sample:
        right === undefined
          ? { sampleRate: decoded.sampleRate, left: decoded.channels[0] }
          : { sampleRate: decoded.sampleRate, left: decoded.channels[0], right },
      gainDb100: numericParam(params, `${voice}.gain`, "gain"),
      panPermille: numericParam(params, `${voice}.pan`, "pan"),
      pitchCents: numericParam(params, `${voice}.pitch`, "pitch"),
      chokeGroup: numericParam(params, `${voice}.chokeGroup`, "chokeGroup"),
    };
    staticValues[`${voice}.gain`] = settings[voice].gainDb100;
    staticValues[`${voice}.pan`] = settings[voice].panPermille;
  }

  const processor = new DrumkitProcessor(sampleRate, settings);
  const output = emptyStereo(totalSamples);
  const automation = new AutomationSet(track.automation);
  let eventIndex = 0;
  for (let blockStart = 0; blockStart < totalSamples; blockStart += CONTROL_BLOCK_SIZE) {
    const length = Math.min(CONTROL_BLOCK_SIZE, totalSamples - blockStart);
    const commands: DrumHitCommand[] = [];
    while (track.events[eventIndex] !== undefined && track.events[eventIndex]!.startSample < blockStart + length) {
      const event = track.events[eventIndex]!;
      if (event.startSample >= blockStart && event.voice !== undefined) {
        commands.push({ offset: event.startSample - blockStart, voice: event.voice, velocity: event.velocity });
      }
      eventIndex++;
    }
    const ramps = automation.ramps(Object.keys(staticValues), staticValues, blockStart, length);
    const left = output.left.subarray(blockStart, blockStart + length);
    const right = output.right.subarray(blockStart, blockStart + length);
    processor.processBlock(left, right, length, commands, ramps);
  }
  return output;
}

function processIntoOutput(
  processor: ReturnType<typeof createSynthProcessor>,
  output: StereoAudio,
  blockStart: number,
  length: number,
  commands: readonly NoteCommand[],
  ramps: ParamRamps,
): void {
  const left = output.left.subarray(blockStart, blockStart + length);
  const right = output.right.subarray(blockStart, blockStart + length);
  processor.processBlock(left, right, length, commands, ramps);
}

function synthCommands(events: readonly CompiledNoteEvent[]): { sample: number; command: NoteCommand }[] {
  const commands: { sample: number; command: NoteCommand }[] = [];
  events.forEach((event, noteId) => {
    commands.push({
      sample: event.startSample,
      command: { offset: 0, kind: "on", noteId, midi: event.midi, velocity: event.velocity },
    });
    commands.push({
      sample: event.startSample + event.durationSamples,
      command: { offset: 0, kind: "off", noteId, midi: event.midi, velocity: event.velocity },
    });
  });
  commands.sort((left, right) => {
    if (left.sample !== right.sample) return left.sample - right.sample;
    if (left.command.kind !== right.command.kind) return left.command.kind === "off" ? -1 : 1;
    return left.command.noteId - right.command.noteId;
  });
  return commands;
}

function synthSettings(instrument: SynthInstrumentDoc): SynthSettings {
  const params = instrument.params ?? {};
  const table = instrument.engine === "basic-mono" ? BASIC_MONO_PARAMS : BASIC_POLY_PARAMS;
  return {
    oscillator: enumParam(params, "oscillator", table.oscillator!.default) as SynthSettings["oscillator"],
    detune: numericSynthParam(params, "detune", table),
    filterType: enumParam(params, "filter.type", table["filter.type"]!.default) as SynthSettings["filterType"],
    filterCutoff: numericSynthParam(params, "filter.cutoff", table),
    filterResonance: numericSynthParam(params, "filter.resonance", table),
    filterEnvAmount: numericSynthParam(params, "filterEnv.amount", table),
    attackMs: numericSynthParam(params, "amp.attack", table),
    decayMs: numericSynthParam(params, "amp.decay", table),
    sustainPermille: numericSynthParam(params, "amp.sustain", table),
    releaseMs: numericSynthParam(params, "amp.release", table),
    gainDb100: numericSynthParam(params, "gain", table),
    panPermille: numericSynthParam(params, "pan", table),
    portamentoMs: instrument.engine === "basic-mono" ? numericSynthParam(params, "portamento", table) : 0,
    maxVoices: instrument.engine === "basic-poly" ? numericSynthParam(params, "maxVoices", table) : 1,
  };
}

function synthAutomationValues(settings: SynthSettings): Record<string, number> {
  return {
    detune: settings.detune,
    "filter.cutoff": settings.filterCutoff,
    "filter.resonance": settings.filterResonance,
    "filterEnv.amount": settings.filterEnvAmount,
    gain: settings.gainDb100,
    pan: settings.panPermille,
  };
}

function numericSynthParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  table: typeof BASIC_MONO_PARAMS,
): number {
  const value = params[key] ?? table[key]?.default;
  if (typeof value !== "number") throw new Error(`cannot render synth: param "${key}" is not numeric`);
  return value;
}

function numericParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  registryKey: keyof typeof DRUMKIT_VOICE_PARAMS,
): number {
  const value = params[key] ?? DRUMKIT_VOICE_PARAMS[registryKey]?.default;
  if (typeof value !== "number") throw new Error(`cannot render drumkit: param "${key}" is not numeric`);
  return value;
}

function enumParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  fallback: number | string,
): string {
  const value = params[key] ?? fallback;
  if (typeof value !== "string") throw new Error(`cannot render synth: param "${key}" is not an enum`);
  return value;
}

function emptyStereo(totalSamples: number): StereoAudio {
  return { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) };
}
