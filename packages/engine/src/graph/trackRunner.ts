import type { CompiledAutomationLane, CompiledNoteEvent, CompiledTrack } from "../compiler.js";
import {
  CONTROL_BLOCK_SIZE,
  DrumkitProcessor,
  createSynthProcessor,
  type DrumHitCommand,
  type DrumVoiceSettings,
  type NoteCommand,
  type SampleData,
  type SynthProcessor,
  type SynthSettings,
} from "../dsp/index.js";
import type { DrumkitInstrumentDoc, InstrumentDoc, SynthInstrumentDoc } from "@chord-garden/format";
import { AutomationRamps } from "./automation.js";
import { compareNoteCommandOrder, noteCommandRank } from "./commands.js";
import {
  drumkitConfiguration,
  synthAutomationValues,
  synthSettings,
  type SampleResolver,
} from "./instrumentSettings.js";

/**
 * One track's audio, driven block by block.
 *
 * Both the offline renderer and the live AudioWorklet drive these: the offline
 * renderer enqueues a whole compiled track up front and walks blocks to the end
 * of the render, the worklet enqueues the same events in lookahead slices and
 * walks blocks as the audio thread asks for them. That is the whole difference
 * between the two paths, which is why "the render sounded different" cannot be a
 * DSP or scheduling divergence — there is one implementation of both.
 *
 * Blocks must be contiguous and events must be enqueued before the block that
 * contains them; both are checked rather than tolerated.
 */
export interface TrackRunner {
  readonly trackId: string;
  /**
   * Add events to the queue. Across all calls, `startSample` must be
   * non-decreasing and no earlier than the next block, so the queue is always a
   * sorted view of everything still to come.
   */
  enqueue(events: readonly CompiledNoteEvent[]): void;
  /** Write `length` samples for the block at absolute position `blockStart`. */
  processBlock(left: Float32Array, right: Float32Array, length: number, blockStart: number): void;
  /** Drop queued events, silence sounding voices, and continue from `position`. */
  reset(position: number): void;
  activeVoiceCount(): number;
  /**
   * Adopt new parameter values in place, restarting nothing. Anything the DSP
   * fixes at construction — the engine, the polyphony, the kit's voices, which
   * file a voice plays — cannot change this way and throws, because that is a
   * structural change and belongs at a bar boundary (PLAN.md §12 step 6).
   */
  updateInstrument(instrument: InstrumentDoc, automation: readonly CompiledAutomationLane[]): void;
  /** Point every voice using `path` at replacement content (see `SampleStore`). */
  replaceSample(path: string, data: SampleData): void;
}

interface PendingOff {
  sample: number;
  noteId: number;
  midi: number;
  velocity: number;
}

/** Consumed queue entries are compacted only once this many have accumulated. */
const COMPACT_THRESHOLD = 512;

abstract class BaseTrackRunner<Command> implements TrackRunner {
  /** Enqueued events not yet delivered to the processor, oldest at `head`. */
  protected readonly pending: CompiledNoteEvent[] = [];
  protected head = 0;
  /** Entries dropped by compaction, so `consumed + index` is a stable event number. */
  protected consumed = 0;
  protected processedThrough = 0;
  private lastEnqueuedSample = -1;

  /**
   * Command objects handed to the processor. `pool` owns them for the lifetime
   * of the runner and `active` is the per-block view the processor iterates, so
   * a block's commands cost no allocation once the pool has grown to the
   * high-water mark of commands in a single block.
   */
  protected readonly pool: Command[] = [];
  protected readonly active: Command[] = [];

  constructor(readonly trackId: string) {}

  enqueue(events: readonly CompiledNoteEvent[]): void {
    for (const event of events) {
      if (event.startSample < this.lastEnqueuedSample) {
        throw new Error(
          `cannot enqueue on track "${this.trackId}": event at sample ${event.startSample} is behind the queued sample ${this.lastEnqueuedSample}`,
        );
      }
      if (event.startSample < this.processedThrough) {
        throw new Error(
          `cannot enqueue on track "${this.trackId}": event at sample ${event.startSample} is inside a block already processed (through ${this.processedThrough})`,
        );
      }
      this.lastEnqueuedSample = event.startSample;
      this.pending.push(event);
      this.onEnqueued(event);
    }
  }

  processBlock(left: Float32Array, right: Float32Array, length: number, blockStart: number): void {
    if (blockStart !== this.processedThrough) {
      throw new Error(
        `cannot process track "${this.trackId}": block at ${blockStart} does not continue from ${this.processedThrough}`,
      );
    }
    if (length <= 0 || length > CONTROL_BLOCK_SIZE) {
      throw new Error(`cannot process track "${this.trackId}": block length ${length} is outside 1..${CONTROL_BLOCK_SIZE}`);
    }
    this.active.length = 0;
    this.collect(blockStart, blockStart + length);
    this.run(left, right, length, blockStart);
    this.processedThrough = blockStart + length;
    if (this.head >= COMPACT_THRESHOLD) {
      this.pending.copyWithin(0, this.head);
      this.pending.length -= this.head;
      this.consumed += this.head;
      this.head = 0;
    }
  }

  reset(position: number): void {
    this.pending.length = 0;
    this.head = 0;
    this.consumed = 0;
    this.active.length = 0;
    this.processedThrough = position;
    this.lastEnqueuedSample = -1;
    this.onReset();
  }

  abstract activeVoiceCount(): number;
  abstract updateInstrument(instrument: InstrumentDoc, automation: readonly CompiledAutomationLane[]): void;
  /** A fresh command object for the pool; called only while the pool grows. */
  protected abstract createCommand(): Command;

  replaceSample(_path: string, _data: SampleData): void {}

  protected abstract onEnqueued(event: CompiledNoteEvent): void;
  protected abstract onReset(): void;
  protected abstract collect(blockStart: number, blockEnd: number): void;
  protected abstract run(left: Float32Array, right: Float32Array, length: number, blockStart: number): void;

  /**
   * The pooled slot for command `index` of this block; never one already in use,
   * because `active` only ever holds pool entries below its own length. Takes no
   * factory callback on purpose: a closure argument would allocate once per
   * command, on the audio thread, which is the cost this pool exists to avoid.
   */
  protected slot(index: number): Command {
    const existing = this.pool[index];
    if (existing !== undefined) return existing;
    const created = this.createCommand();
    this.pool[index] = created;
    return created;
  }
}

export class SynthTrackRunner extends BaseTrackRunner<NoteCommand> {
  private readonly processor: SynthProcessor;
  private readonly ramps: AutomationRamps;
  /**
   * Note-offs for every enqueued note that has not been delivered yet, in no
   * particular order: the per-block insertion sort establishes the order, so
   * keeping this set sorted as well would be duplicated work. Registered at
   * enqueue time rather than when the note starts, so a zero-length note's
   * note-off is present in the same block as its note-on.
   */
  private readonly offs: PendingOff[] = [];
  private offCount = 0;

  /**
   * The processor reads these fields every sample, so mutating them in place is
   * how a live parameter tweak reaches the DSP without restarting a voice.
   */
  private readonly settings: SynthSettings;
  private readonly staticValues: Record<string, number>;
  private readonly engine: SynthInstrumentDoc["engine"];

  constructor(track: CompiledTrack, instrument: SynthInstrumentDoc, sampleRate: number) {
    super(track.trackId);
    this.settings = synthSettings(instrument);
    this.staticValues = synthAutomationValues(this.settings);
    this.engine = instrument.engine;
    this.processor = createSynthProcessor(instrument.engine, sampleRate, this.settings);
    this.ramps = new AutomationRamps(track.automation, this.staticValues);
  }

  activeVoiceCount(): number {
    return this.processor.activeVoiceCount();
  }

  updateInstrument(instrument: InstrumentDoc, automation: readonly CompiledAutomationLane[]): void {
    if (instrument.type !== "synth") {
      throw new Error(`cannot update track "${this.trackId}" in place: instrument became a ${instrument.type}`);
    }
    if (instrument.engine !== this.engine) {
      throw new Error(
        `cannot update track "${this.trackId}" in place: engine went from "${this.engine}" to "${instrument.engine}"`,
      );
    }
    const next = synthSettings(instrument);
    if (next.maxVoices !== this.settings.maxVoices) {
      throw new Error(
        `cannot update track "${this.trackId}" in place: maxVoices went from ${this.settings.maxVoices} to ${next.maxVoices}`,
      );
    }
    // Envelope segment times are copied by each note-on, so a change to them
    // lands on the next note rather than bending one already sounding.
    Object.assign(this.settings, next);
    Object.assign(this.staticValues, synthAutomationValues(next));
    this.ramps.replaceLanes(automation);
  }

  /**
   * A note's id is its position in the stream of events enqueued since the last
   * reset, which for a whole schedule enqueued at once is its index in
   * `CompiledTrack.events` — so the offline render and a sliced live run label
   * the same note identically, and the note order in `commands.ts` ties break
   * the same way on both paths.
   */
  protected onEnqueued(event: CompiledNoteEvent): void {
    const slot = this.offSlot();
    slot.sample = event.startSample + event.durationSamples;
    slot.noteId = this.consumed + this.pending.length - 1;
    slot.midi = event.midi;
    slot.velocity = event.velocity;
    this.offCount++;
  }

  protected onReset(): void {
    // No voice survives a reset, so ids may restart from zero: the same
    // schedule replayed from the same position produces the same ids.
    this.offCount = 0;
    this.processor.reset();
  }

  protected collect(blockStart: number, blockEnd: number): void {
    while (this.head < this.pending.length) {
      const event = this.pending[this.head]!;
      if (event.startSample >= blockEnd) break;
      this.insert(event.startSample - blockStart, "on", this.consumed + this.head, event.midi, event.velocity);
      this.head++;
    }
    for (let index = this.offCount - 1; index >= 0; index--) {
      const off = this.offs[index]!;
      if (off.sample >= blockEnd) continue;
      this.insert(off.sample - blockStart, "off", off.noteId, off.midi, off.velocity);
      const last = this.offs[this.offCount - 1]!;
      this.offs[index] = last;
      this.offs[this.offCount - 1] = off;
      this.offCount--;
    }
  }

  protected run(left: Float32Array, right: Float32Array, length: number, blockStart: number): void {
    this.processor.processBlock(left, right, length, this.active, this.ramps.update(blockStart, length));
  }

  protected createCommand(): NoteCommand {
    return { offset: 0, kind: "on", noteId: 0, midi: 0, velocity: 0 };
  }

  private offSlot(): PendingOff {
    const existing = this.offs[this.offCount];
    if (existing !== undefined) return existing;
    const created: PendingOff = { sample: 0, noteId: 0, midi: 0, velocity: 0 };
    this.offs[this.offCount] = created;
    return created;
  }

  /** Insertion sort into `active`, which keeps the block's stream in note order. */
  private insert(offset: number, kind: NoteCommand["kind"], noteId: number, midi: number, velocity: number): void {
    const count = this.active.length;
    const slot = this.slot(count);
    const rank = noteCommandRank(kind);
    let index = count;
    while (index > 0) {
      const previous = this.active[index - 1]!;
      const order = compareNoteCommandOrder(
        previous.offset,
        noteCommandRank(previous.kind),
        previous.noteId,
        offset,
        rank,
        noteId,
      );
      if (order <= 0) break;
      this.active[index] = previous;
      index--;
    }
    slot.offset = offset;
    slot.kind = kind;
    slot.noteId = noteId;
    slot.midi = midi;
    slot.velocity = velocity;
    this.active[index] = slot;
  }
}

export class DrumkitTrackRunner extends BaseTrackRunner<DrumHitCommand> {
  private readonly processor: DrumkitProcessor;
  private readonly ramps: AutomationRamps;
  private readonly voiceOutputs: ReadonlyMap<string, { left: Float32Array; right: Float32Array }> | undefined;
  private readonly settings: Record<string, DrumVoiceSettings>;
  private readonly staticValues: Record<string, number>;
  /** Which file each kit voice plays, so a replaced sample can find its voices. */
  private readonly samplePaths: Map<string, string>;

  constructor(
    track: CompiledTrack,
    instrument: DrumkitInstrumentDoc,
    sampleRate: number,
    resolveSample: SampleResolver,
    voiceOutputs?: ReadonlyMap<string, { left: Float32Array; right: Float32Array }>,
  ) {
    super(track.trackId);
    const configuration = drumkitConfiguration(instrument, resolveSample);
    this.settings = configuration.settings;
    this.staticValues = configuration.staticValues;
    this.samplePaths = new Map(Object.entries(instrument.kit).map(([voice, kit]) => [voice, kit.sample]));
    this.processor = new DrumkitProcessor(sampleRate, configuration.settings);
    this.ramps = new AutomationRamps(track.automation, configuration.staticValues);
    this.voiceOutputs = voiceOutputs;
  }

  updateInstrument(instrument: InstrumentDoc, automation: readonly CompiledAutomationLane[]): void {
    if (instrument.type !== "drumkit") {
      throw new Error(`cannot update track "${this.trackId}" in place: instrument became a ${instrument.type}`);
    }
    const voices = Object.keys(instrument.kit);
    const current = this.processor.getVoiceNames();
    if (voices.length !== current.length || voices.some((voice, index) => voice !== current[index])) {
      throw new Error(
        `cannot update track "${this.trackId}" in place: kit voices went from [${current.join(", ")}] to [${voices.join(", ")}]`,
      );
    }
    for (const [voice, kit] of Object.entries(instrument.kit)) {
      if (kit.sample !== this.samplePaths.get(voice)) {
        throw new Error(
          `cannot update track "${this.trackId}" in place: voice "${voice}" now plays "${kit.sample}", which needs loading`,
        );
      }
    }
    // Resolving to the sample already in place keeps this free of any loading
    // concern: the paths were just proven identical.
    const next = drumkitConfiguration(instrument, (path) => this.sampleFor(path));
    for (const voice of current) {
      const before = this.settings[voice]!;
      const after = next.settings[voice]!;
      before.gainDb100 = after.gainDb100;
      before.panPermille = after.panPermille;
      before.pitchCents = after.pitchCents;
      before.chokeGroup = after.chokeGroup;
    }
    Object.assign(this.staticValues, next.staticValues);
    this.ramps.replaceLanes(automation);
  }

  /**
   * Swap in replacement content for `path`. A hit already playing keeps its
   * position in the new buffer, so it finishes early if the replacement is
   * shorter — the alternative, deferring to the next bar, would make a sample
   * swap feel broken while auditioning it.
   */
  override replaceSample(path: string, data: SampleData): void {
    for (const [voice, voicePath] of this.samplePaths) {
      if (voicePath === path) this.settings[voice]!.sample = data;
    }
  }

  private sampleFor(path: string): SampleData {
    for (const [voice, voicePath] of this.samplePaths) {
      if (voicePath === path) return this.settings[voice]!.sample;
    }
    throw new Error(`cannot update track "${this.trackId}" in place: no voice plays "${path}"`);
  }

  getVoiceNames(): readonly string[] {
    return this.processor.getVoiceNames();
  }

  activeVoiceCount(): number {
    return this.processor.getActiveVoiceCount();
  }

  protected onEnqueued(): void {}

  protected createCommand(): DrumHitCommand {
    return { offset: 0, voice: "", velocity: 0 };
  }

  protected onReset(): void {
    this.processor.reset();
  }

  protected collect(blockStart: number, blockEnd: number): void {
    while (this.head < this.pending.length) {
      const event = this.pending[this.head]!;
      if (event.startSample >= blockEnd) break;
      this.head++;
      if (event.voice === undefined) continue;
      const slot = this.slot(this.active.length);
      slot.offset = event.startSample - blockStart;
      slot.voice = event.voice;
      slot.velocity = event.velocity;
      this.active.push(slot);
    }
  }

  protected run(left: Float32Array, right: Float32Array, length: number, blockStart: number): void {
    const ramps = this.ramps.update(blockStart, length);
    if (this.voiceOutputs === undefined) {
      this.processor.processBlock(left, right, length, this.active, ramps);
      return;
    }
    // Offline only: per-voice isolation needs one full-length buffer per kit
    // voice, so the live engine never asks for it and never pays for these views.
    const blocks: Record<string, { left: Float32Array; right: Float32Array }> = {};
    for (const voice of this.processor.getVoiceNames()) {
      const audio = this.voiceOutputs.get(voice);
      if (audio === undefined) throw new Error(`cannot process drumkit: no buffer for kit voice "${voice}"`);
      blocks[voice] = {
        left: audio.left.subarray(blockStart, blockStart + length),
        right: audio.right.subarray(blockStart, blockStart + length),
      };
    }
    this.processor.processBlock(left, right, length, this.active, ramps, blocks);
  }
}

export function createTrackRunner(
  track: CompiledTrack,
  instrument: InstrumentDoc,
  sampleRate: number,
  resolveSample: SampleResolver,
  voiceOutputs?: ReadonlyMap<string, { left: Float32Array; right: Float32Array }>,
): TrackRunner {
  if (instrument.type === "synth") return new SynthTrackRunner(track, instrument, sampleRate);
  return new DrumkitTrackRunner(track, instrument, sampleRate, resolveSample, voiceOutputs);
}
