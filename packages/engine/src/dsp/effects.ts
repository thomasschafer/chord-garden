import { rampValue, type ParamRamps } from "./control.js";
import { DelayEffect, type DelaySettings } from "./delay.js";
import { BiquadFilter, type FilterType } from "./filter.js";
import { ReverbEffect, type ReverbSettings } from "./reverb.js";

export interface FilterEffectSettings {
  mode: FilterType;
  /** Hz 20..20000, as persisted. */
  cutoffHz: number;
  /** permille 0..1000, as persisted. */
  resonancePermille: number;
}

/**
 * A whole-track filter: the same `BiquadFilter`, the same Q mapping and the same
 * three responses a synth voice's `filter.*` uses, one instance per channel.
 *
 * Reusing the class is the point rather than a convenience. A second filter
 * implementation would mean a cutoff sweep on a track and the identical sweep
 * inside an instrument could sound different, and no test on either one alone
 * would show it.
 */
export class FilterEffect {
  private readonly left: BiquadFilter;
  private readonly right: BiquadFilter;
  private readonly cutoffKey: string;
  private readonly resonanceKey: string;
  /** Last coefficients computed, so a static filter recomputes once per block. */
  private lastMode: FilterType | undefined;
  private lastCutoff = Number.NaN;
  private lastResonance = Number.NaN;

  constructor(
    id: string,
    sampleRate: number,
    readonly settings: FilterEffectSettings,
  ) {
    this.left = new BiquadFilter(sampleRate);
    this.right = new BiquadFilter(sampleRate);
    this.cutoffKey = `fx.${id}.cutoff`;
    this.resonanceKey = `fx.${id}.resonance`;
  }

  processBlock(left: Float32Array, right: Float32Array, length: number, ramps: ParamRamps): void {
    for (let index = 0; index < length; index++) {
      const cutoff = rampValue(ramps[this.cutoffKey], this.settings.cutoffHz, index, length);
      const resonance = rampValue(ramps[this.resonanceKey], this.settings.resonancePermille, index, length);
      // Recomputed only when something moved. Not merely an optimisation for the
      // unautomated case: the coefficients are a pure function of these three
      // numbers, so skipping an identical recompute cannot change a single sample,
      // which is what lets a per-sample sweep stay affordable.
      if (cutoff !== this.lastCutoff || resonance !== this.lastResonance || this.settings.mode !== this.lastMode) {
        this.left.setParameters(this.settings.mode, cutoff, resonance);
        this.right.setParameters(this.settings.mode, cutoff, resonance);
        this.lastMode = this.settings.mode;
        this.lastCutoff = cutoff;
        this.lastResonance = resonance;
      }
      left[index] = this.left.process(left[index]!);
      right[index] = this.right.process(right[index]!);
    }
  }

  reset(): void {
    this.left.reset();
    this.right.reset();
    this.lastMode = undefined;
    this.lastCutoff = Number.NaN;
    this.lastResonance = Number.NaN;
  }
}

/**
 * One effect's identity and its DSP settings.
 *
 * `id` is carried alongside the settings because it is what automation addresses:
 * the processors build their ramp keys from it, so `fx.<id>.<param>` reaches this
 * effect and no other however the chain is ordered.
 */
export type EffectSpec =
  | { id: string; type: "delay"; settings: DelaySettings }
  | { id: string; type: "reverb"; settings: ReverbSettings }
  | { id: string; type: "filter"; settings: FilterEffectSettings };

interface ChainEntry {
  id: string;
  type: EffectSpec["type"];
  processor: DelayEffect | ReverbEffect | FilterEffect;
  settings: DelaySettings | ReverbSettings | FilterEffectSettings;
}

/**
 * A track's effect chain, applied in order after the instrument.
 *
 * Processes in place on the track's own stereo buffer, so a chain is a series of
 * inserts with no bus to allocate and no summing to get wrong. Both the offline
 * renderer and the live worklet drive this same object through the same
 * `TrackRunner`, which is what makes live and offline the same sound rather than
 * two implementations that agree today.
 */
export class EffectChain {
  private readonly entries: ChainEntry[];
  /** The chain's shape, for the in-place-update check. */
  readonly identity: string;

  constructor(sampleRate: number, specs: readonly EffectSpec[]) {
    this.entries = specs.map((spec) => createEntry(sampleRate, spec));
    this.identity = chainIdentity(specs);
  }

  get length(): number {
    return this.entries.length;
  }

  processBlock(left: Float32Array, right: Float32Array, length: number, ramps: ParamRamps): void {
    for (const entry of this.entries) entry.processor.processBlock(left, right, length, ramps);
  }

  reset(): void {
    for (const entry of this.entries) entry.processor.reset();
  }

  /**
   * Adopt new param values in place, restarting nothing and clearing no tail.
   *
   * Refuses anything that changes the chain's *shape* — an effect added, removed,
   * reordered, or retyped. Those are graph changes and belong at a bar boundary
   * (PLAN.md §12 step 6), and this check is the only thing that catches a
   * misclassified reorder: reordering a chain moves no event, so the scheduler's
   * own event comparison sees nothing wrong and would let it through.
   */
  updateSettings(specs: readonly EffectSpec[]): void {
    const next = chainIdentity(specs);
    if (next !== this.identity) {
      throw new Error(
        `cannot update an effect chain in place: chain went from [${this.identity}] to [${next}], which is structural`,
      );
    }
    specs.forEach((spec, index) => {
      Object.assign(this.entries[index]!.settings, spec.settings);
    });
  }
}

/** The ordered ids and types of a chain — what may not change in place. */
export function chainIdentity(specs: readonly EffectSpec[]): string {
  return specs.map((spec) => `${spec.id}:${spec.type}`).join(", ");
}

function createEntry(sampleRate: number, spec: EffectSpec): ChainEntry {
  switch (spec.type) {
    case "delay": {
      const settings = { ...spec.settings };
      return { id: spec.id, type: spec.type, settings, processor: new DelayEffect(spec.id, sampleRate, settings) };
    }
    case "reverb": {
      const settings = { ...spec.settings };
      return { id: spec.id, type: spec.type, settings, processor: new ReverbEffect(spec.id, sampleRate, settings) };
    }
    case "filter": {
      const settings = { ...spec.settings };
      return { id: spec.id, type: spec.type, settings, processor: new FilterEffect(spec.id, sampleRate, settings) };
    }
  }
}
