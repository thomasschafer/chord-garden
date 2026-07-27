import type { CompiledAutomationLane, CompiledNoteEvent, CompiledTrack } from "../compiler.js";
import {
  CONTROL_BLOCK_SIZE,
  DrumkitProcessor,
  EffectChain,
  createSynthProcessor,
  type DrumHitCommand,
  type DrumVoiceSettings,
  type NoteCommand,
  type ParamRamps,
  type SampleData,
  type SynthProcessor,
  type SynthSettings,
} from "../dsp/index.js";
import type { DrumkitInstrumentDoc, EffectDoc, InstrumentDoc, SynthInstrumentDoc } from "@chord-garden/format";
import { AutomationRamps } from "./automation.js";
import { compareNoteCommandOrder, noteCommandRank } from "./commands.js";
import { effectChainSpecs, effectStaticValues } from "./effectSettings.js";
import {
  drumkitConfiguration,
  synthAutomationValues,
  synthSettings,
  type SampleResolver,
} from "./instrumentSettings.js";

/** A pair of planar channel buffers; the shape the runner reads and writes. */
export interface StereoBuffers {
  left: Float32Array;
  right: Float32Array;
}

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
   * Adopt new parameter values in place, restarting nothing and clearing no
   * effect tail. Anything the DSP fixes at construction — the engine, the
   * polyphony, the kit's voices, which file a voice plays, and the shape of the
   * effect chain — cannot change this way and throws, because that is a
   * structural change and belongs at a bar boundary (PLAN.md §12 step 6).
   */
  updateSettings(
    instrument: InstrumentDoc,
    effects: readonly EffectDoc[],
    automation: readonly CompiledAutomationLane[],
  ): void;
  /**
   * Point every voice using `path` at replacement content, for its next trigger
   * onwards (see `SampleStore`, and `DrumkitTrackRunner.replaceSample` for why it
   * is the next trigger and not the sounding one).
   */
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

  /**
   * The track's inserts, or undefined when it has none — undefined rather than an
   * empty chain so a project without effects pays nothing at all, neither a call
   * nor a branch per effect.
   */
  protected readonly chain: EffectChain | undefined;

  constructor(
    readonly trackId: string,
    effects: readonly EffectDoc[],
    sampleRate: number,
    /**
     * Offline only: a full-length buffer to receive this track's audio *before*
     * its effect chain.
     *
     * `render --analyze` needs it because onset detection is a question about the
     * source, not about the room it is played in: a delay's repeats are sound at
     * positions nothing scheduled, and measuring them as unaccounted-for would
     * report a false `spurious` on a healthy project. The live engine never asks
     * for it and never allocates it.
     */
    private readonly dryOutput?: StereoBuffers,
  ) {
    const specs = effectChainSpecs(effects);
    this.chain = specs.length === 0 ? undefined : new EffectChain(sampleRate, specs);
  }

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
    // Ramps are computed once here rather than inside each `run`, because the
    // effect chain needs the same block's ramps: an automation lane on
    // `fx.<id>.<param>` is one entry in this record beside `filter.cutoff`, which
    // is what lets an effect param be automated with no new machinery at all.
    const ramps = this.updateRamps(blockStart, length);
    this.run(left, right, length, blockStart, ramps);
    if (this.dryOutput !== undefined) {
      this.dryOutput.left.set(left.subarray(0, length), blockStart);
      this.dryOutput.right.set(right.subarray(0, length), blockStart);
    }
    this.chain?.processBlock(left, right, length, ramps);
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
    // Tails are cut, not left ringing: the transport's position stops advancing or
    // jumps, so a delay repeat still sounding would be audible at a position the
    // playhead is no longer at — the same reason `SynthProcessor.reset` drops
    // releases rather than letting them finish.
    this.chain?.reset();
    this.onReset();
  }

  abstract activeVoiceCount(): number;
  abstract updateSettings(
    instrument: InstrumentDoc,
    effects: readonly EffectDoc[],
    automation: readonly CompiledAutomationLane[],
  ): void;
  /** This block's parameter ramps, including any on `fx.<id>.<param>`. */
  protected abstract updateRamps(blockStart: number, length: number): ParamRamps;
  /** A fresh command object for the pool; called only while the pool grows. */
  protected abstract createCommand(): Command;

  replaceSample(_path: string, _data: SampleData): void {}

  protected abstract onEnqueued(event: CompiledNoteEvent): void;
  protected abstract onReset(): void;
  protected abstract collect(blockStart: number, blockEnd: number): void;
  protected abstract run(
    left: Float32Array,
    right: Float32Array,
    length: number,
    blockStart: number,
    ramps: ParamRamps,
  ): void;

  /**
   * Adopt the effect chain's new param values, or refuse a change of shape.
   *
   * Separate from the instrument half so both subclasses share it: an effect chain
   * belongs to the track, and neither the engine nor the kit has an opinion on it.
   */
  protected updateChain(effects: readonly EffectDoc[]): void {
    const specs = effectChainSpecs(effects);
    if (this.chain === undefined) {
      if (specs.length === 0) return;
      throw new Error(
        `cannot update track "${this.trackId}" in place: an effect chain was added, which is structural`,
      );
    }
    this.chain.updateSettings(specs);
  }

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

  constructor(track: CompiledTrack, instrument: SynthInstrumentDoc, sampleRate: number, dryOutput?: StereoBuffers) {
    super(track.trackId, track.effects, sampleRate, dryOutput);
    this.settings = synthSettings(instrument);
    // The instrument's ramped params and the chain's in one record: the DSP asks
    // for `fx.room.mix` exactly as it asks for `filter.cutoff`.
    this.staticValues = { ...synthAutomationValues(this.settings), ...effectStaticValues(track.effects) };
    this.engine = instrument.engine;
    this.processor = createSynthProcessor(instrument.engine, sampleRate, this.settings);
    this.ramps = new AutomationRamps(track.automation, this.staticValues);
  }

  activeVoiceCount(): number {
    return this.processor.activeVoiceCount();
  }

  protected updateRamps(blockStart: number, length: number): ParamRamps {
    return this.ramps.update(blockStart, length);
  }

  updateSettings(
    instrument: InstrumentDoc,
    effects: readonly EffectDoc[],
    automation: readonly CompiledAutomationLane[],
  ): void {
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
    this.updateChain(effects);
    // Envelope segment times are copied by each note-on, so a change to them
    // lands on the next note rather than bending one already sounding.
    Object.assign(this.settings, next);
    Object.assign(this.staticValues, synthAutomationValues(next));
    Object.assign(this.staticValues, effectStaticValues(effects));
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

  protected run(left: Float32Array, right: Float32Array, length: number, _blockStart: number, ramps: ParamRamps): void {
    this.processor.processBlock(left, right, length, this.active, ramps);
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
    dryOutput?: StereoBuffers,
  ) {
    super(track.trackId, track.effects, sampleRate, dryOutput);
    const configuration = drumkitConfiguration(instrument, resolveSample);
    this.settings = configuration.settings;
    this.staticValues = { ...configuration.staticValues, ...effectStaticValues(track.effects) };
    this.samplePaths = new Map(Object.entries(instrument.kit).map(([voice, kit]) => [voice, kit.sample]));
    this.processor = new DrumkitProcessor(sampleRate, configuration.settings);
    this.ramps = new AutomationRamps(track.automation, this.staticValues);
    this.voiceOutputs = voiceOutputs;
  }

  protected updateRamps(blockStart: number, length: number): ParamRamps {
    return this.ramps.update(blockStart, length);
  }

  updateSettings(
    instrument: InstrumentDoc,
    effects: readonly EffectDoc[],
    automation: readonly CompiledAutomationLane[],
  ): void {
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
    this.updateChain(effects);
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
    Object.assign(this.staticValues, effectStaticValues(effects));
    this.ramps.replaceLanes(automation);
  }

  /**
   * Adopt replacement content for `path`, for the hits that come after it.
   *
   * The timing is deliberately between the two obvious choices. Deferring the swap
   * to the next bar, as a structural graph change is deferred, would make
   * auditioning a replaced sample feel broken. Swapping it under the hits already
   * sounding would splice two unrelated waveforms together mid-voice, which is a
   * click — and a click is exactly what "the file changed and you heard it change"
   * must not sound like. So the new buffer takes effect at the next trigger and a
   * sounding hit finishes on the buffer it started with; `PlaybackVoice.sample` is
   * what holds it there.
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

  protected run(left: Float32Array, right: Float32Array, length: number, blockStart: number, ramps: ParamRamps): void {
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
  dryOutput?: StereoBuffers,
): TrackRunner {
  if (instrument.type === "synth") return new SynthTrackRunner(track, instrument, sampleRate, dryOutput);
  return new DrumkitTrackRunner(track, instrument, sampleRate, resolveSample, voiceOutputs, dryOutput);
}
