import type { CompiledSchedule, StereoAudio } from "@chord-garden/engine";

export const SILENCE_PEAK_THRESHOLD = 0.001;
export const CLIPPING_THRESHOLD = 1;
export const ONSET_WINDOW_MS = 4;
export const ONSET_HOP_MS = 1;
export const ONSET_REFRACTORY_MS = 5;
export const ONSET_TOLERANCE_MS = 12;
export const ONSET_ENERGY_RISE_RATIO = 1.15;
export const ONSET_MIN_RMS = 0.0001;
export const SPURIOUS_ONSET_WINDOW_MS = 20;
export const SPURIOUS_ONSET_ENERGY_RISE_RATIO = 1.15;
/**
 * How long after a scheduled position a peak-envelope candidate still counts as
 * that event's own attack rather than unscheduled sound.
 *
 * A candidate marks an envelope *maximum*, not an attack, and a low-frequency
 * resonant voice reaches that maximum well after its note starts: the worked
 * example's 55 Hz bass through `filter.resonance: 200` is loudest on its second
 * oscillator cycle, ~20 ms in, because the filter is still ringing up through
 * the first. The second cycle genuinely exceeds the first by more than
 * SPURIOUS_ONSET_ENERGY_RISE_RATIO, so no rise test can separate it from a real
 * extra hit of similar level; the separation has to be made here, in
 * attribution.
 *
 * 30 ms is engineering judgement, deliberately round. The measured worst case on
 * the worked example is ~20 ms (971 samples at 48 kHz), and this leaves margin
 * for a lower or more resonant voice without opening a blind spot wide enough to
 * hide a 32nd-note ratchet (60 ms at 124 BPM). Widening it hides extra attacks
 * closer to the beat; narrowing it reports a resonant voice's own peak as
 * spurious, which is the false-positive warning PLAN.md §13 forbids. Both sides
 * of the boundary are pinned by tests, so changing this value shows you exactly
 * what you traded.
 */
export const SPURIOUS_MAX_ATTACK_LAG_MS = 30;
export const UNMATCHED_EXPECTED_LIMIT = 32;
export const SPURIOUS_POSITIONS_LIMIT = 32;
export const SPURIOUS_WARNING_MINIMUM_COUNT = 8;
export const SPURIOUS_WARNING_EXPECTED_RATIO = 0.25;
export const SPECTRAL_BAND_EDGES_HZ = [20, 80, 250, 800, 2_500, 8_000, 20_000] as const;

const FFT_SIZE = 2_048;
const SPECTRAL_MAX_FRAMES = 32;
const ENERGY_FLOOR = 1e-20;

export interface ClippingAnalysis {
  clipped: boolean;
  /** Counts individual channel samples, while firstSampleIndex is a stereo frame index. */
  sampleCount: number;
  firstSampleIndex: number | null;
}

export interface SignalAnalysis {
  peak: number;
  /** Null represents negative infinity for an exactly silent signal. */
  peakDb: number | null;
  rms: number;
  /** Null represents negative infinity for an exactly silent signal. */
  rmsDb: number | null;
  clipping: ClippingAnalysis;
  silent: boolean;
}

export interface OnsetAnalysis {
  /** Coincident scheduled events are one observable onset and are counted once. */
  expected: number;
  /** Energy-rise candidates assigned to an expected position within tolerance; always equals matched. */
  detected: number;
  /** Expected positions assigned an energy-rise candidate within tolerance; always equals detected. */
  matched: number;
  /** Precision peak-envelope candidates not assigned to any expected position. */
  spurious: number;
  meanOffsetSamples: number;
  maxOffsetSamples: number;
  unmatchedExpected: number[];
  /**
   * Sample positions for spurious candidates, capped by
   * parameters.onset.spurious.positionsLimit. Each lands within
   * parameters.onset.spurious.timestampMaxErrorSamples before the transient it
   * reports, so an agent can seek to the position and find the sound.
   */
  spuriousPositions: number[];
}

export interface SpectralBandAnalysis {
  minHz: number;
  maxHz: number;
  share: number;
}

export interface SpectralAnalysis {
  centroidHz: number;
  bands: SpectralBandAnalysis[];
}

export interface TrackAnalysis extends SignalAnalysis {
  id: string;
  eventCount: number;
  onsets: OnsetAnalysis;
  spectral: SpectralAnalysis;
}

/**
 * When a peak-envelope candidate counts as a scheduled event's own attack
 * rather than unscheduled sound. The window is asymmetric: sound cannot precede
 * the note that makes it, so before an expected position only the onset timing
 * tolerance applies, while after it a voice's envelope peak may lag by up to
 * SPURIOUS_MAX_ATTACK_LAG_MS — see that constant for why.
 */
export interface SpuriousAttribution {
  /** Most a candidate may precede an expected position: the onset timing tolerance. */
  earliestSamples: number;
  /** Most a candidate may follow an expected position: maxAttackLagMs in samples. */
  latestSamples: number;
  /** SPURIOUS_MAX_ATTACK_LAG_MS, reported in its own unit as the judgement call it is. */
  maxAttackLagMs: number;
  rule: "expected + earliestSamples <= candidate && candidate <= expected + latestSamples";
}

export interface AnalysisParameters {
  silencePeakThreshold: number;
  clippingThreshold: number;
  onset: {
    detector: "short-window-energy-rise";
    windowSamples: number;
    hopSamples: number;
    energyRiseRatio: number;
    minimumRms: number;
    refractorySamples: number;
    toleranceSamples: number;
    /** Windows a rise is measured against; frames before sample 0 count as silent. */
    baselineLookbackFrames: number;
    preBufferTreatedAsSilence: true;
    coincidentEventsCollapsed: true;
    reportsScheduleMatchedCandidatesOnly: false;
    unmatchedExpectedLimit: number;
    spurious: {
      detector: "short-window-peak-envelope-rise";
      windowSamples: number;
      hopSamples: number;
      energyRiseRatio: number;
      minimumPeak: number;
      refractorySamples: number;
      toleranceSamples: number;
      baselineLookbackFrames: number;
      /** Subtracted from the causal window's end to place a reported position. */
      timestampCompensationSamples: number;
      /**
       * Bound on how far a reported spuriousPositions entry can sit from the
       * envelope peak it detected. Positions are never later than that peak.
       */
      timestampMaxErrorSamples: number;
      attribution: SpuriousAttribution;
      positionsLimit: number;
      warning: {
        minimumCount: number;
        expectedRatio: number;
        rule: "spurious >= minimumCount && (expected === 0 || spurious / expected > expectedRatio)";
      };
    };
  };
  spectral: {
    fftSize: number;
    maxFrames: number;
    bandEdgesHz: number[];
  };
}

export interface AnalysisReport {
  version: 1;
  sampleRate: number;
  seed: number;
  barRange: { start: number; end: number } | null;
  totalSamples: number;
  durationSeconds: number;
  parameters: AnalysisParameters;
  master: SignalAnalysis;
  tracks: TrackAnalysis[];
  warnings: string[];
}

export interface AnalyzeOptions {
  seed: number;
  barRange?: { start: number; end: number };
}

interface OnsetCandidate {
  sample: number;
  strength: number;
}

/**
 * Scheduled-onset matching favours recall with short-window stereo energy.
 * Spurious-onset reporting uses a longer peak envelope so oscillator cycles
 * and ringing tails do not masquerade as hundreds of unscheduled attacks.
 */
export function analyzeRender(
  master: StereoAudio,
  stems: ReadonlyMap<string, StereoAudio>,
  schedule: CompiledSchedule,
  options: AnalyzeOptions,
): AnalysisReport {
  const parameters = analysisParameters(schedule.sampleRate);
  const warnings: string[] = [];
  const masterAnalysis = analyzeSignal(master);
  if (masterAnalysis.clipping.clipped) {
    warnings.push(
      `Master clipping: ${masterAnalysis.clipping.sampleCount} channel samples exceed |${CLIPPING_THRESHOLD}| (first frame ${masterAnalysis.clipping.firstSampleIndex}).`,
    );
  }

  const tracks = schedule.tracks.map((track): TrackAnalysis => {
    const audio = stems.get(track.trackId);
    if (audio === undefined) throw new Error(`cannot analyze: rendered stem for track "${track.trackId}" is missing`);
    const signal = analyzeSignal(audio);
    const expectedPositions = uniqueSorted(track.events.map((event) => event.startSample));
    const detectedPositions = detectOnsets(audio, schedule.sampleRate);
    const spuriousCandidatePositions = detectSpuriousOnsets(audio, schedule.sampleRate);
    const onsets = matchOnsets(
      expectedPositions,
      detectedPositions,
      spuriousCandidatePositions,
      parameters.onset.toleranceSamples,
      parameters.onset.spurious.attribution,
    );

    if (track.events.length > 0 && signal.silent) {
      warnings.push(
        `Track "${track.trackId}": events but silent (${track.events.length} scheduled; peak ${formatMetric(signal.peak)} is below ${SILENCE_PEAK_THRESHOLD}).`,
      );
    }
    if (onsets.matched !== onsets.expected) {
      warnings.push(
        `Track "${track.trackId}": onset mismatch (matched ${onsets.matched} of ${onsets.expected} expected positions; ${onsets.expected - onsets.matched} unmatched).`,
      );
    }
    if (shouldWarnForSpuriousOnsets(onsets)) {
      warnings.push(
        `Track "${track.trackId}": disproportionate spurious onsets (${onsets.spurious} spurious for ${onsets.expected} expected; warning requires at least ${SPURIOUS_WARNING_MINIMUM_COUNT} and either no expected positions or more than ${SPURIOUS_WARNING_EXPECTED_RATIO * 100}% of expected).`,
      );
    }

    return {
      id: track.trackId,
      eventCount: track.events.length,
      ...signal,
      onsets,
      spectral: analyzeSpectrum(audio, schedule.sampleRate),
    };
  });

  return {
    version: 1,
    sampleRate: schedule.sampleRate,
    seed: options.seed,
    barRange: options.barRange ?? null,
    totalSamples: master.left.length,
    durationSeconds: master.left.length / schedule.sampleRate,
    parameters,
    master: masterAnalysis,
    tracks,
    warnings,
  };
}

function analysisParameters(sampleRate: number): AnalysisParameters {
  const hopSamples = millisecondsToSamples(ONSET_HOP_MS, sampleRate);
  const windowSamples = millisecondsToSamples(ONSET_WINDOW_MS, sampleRate);
  const spuriousWindowSamples = millisecondsToSamples(SPURIOUS_ONSET_WINDOW_MS, sampleRate);
  return {
    silencePeakThreshold: SILENCE_PEAK_THRESHOLD,
    clippingThreshold: CLIPPING_THRESHOLD,
    onset: {
      detector: "short-window-energy-rise",
      windowSamples,
      hopSamples,
      energyRiseRatio: ONSET_ENERGY_RISE_RATIO,
      minimumRms: ONSET_MIN_RMS,
      refractorySamples: millisecondsToSamples(ONSET_REFRACTORY_MS, sampleRate),
      toleranceSamples: millisecondsToSamples(ONSET_TOLERANCE_MS, sampleRate),
      baselineLookbackFrames: baselineLookbackFrames(windowSamples, hopSamples),
      preBufferTreatedAsSilence: true,
      coincidentEventsCollapsed: true,
      reportsScheduleMatchedCandidatesOnly: false,
      unmatchedExpectedLimit: UNMATCHED_EXPECTED_LIMIT,
      spurious: {
        detector: "short-window-peak-envelope-rise",
        windowSamples: spuriousWindowSamples,
        hopSamples,
        energyRiseRatio: SPURIOUS_ONSET_ENERGY_RISE_RATIO,
        minimumPeak: ONSET_MIN_RMS,
        refractorySamples: millisecondsToSamples(ONSET_REFRACTORY_MS, sampleRate),
        toleranceSamples: millisecondsToSamples(ONSET_TOLERANCE_MS, sampleRate),
        baselineLookbackFrames: baselineLookbackFrames(windowSamples, hopSamples),
        timestampCompensationSamples: spuriousTimestampCompensationSamples(hopSamples),
        timestampMaxErrorSamples: hopSamples,
        attribution: spuriousAttribution(sampleRate, millisecondsToSamples(ONSET_TOLERANCE_MS, sampleRate)),
        positionsLimit: SPURIOUS_POSITIONS_LIMIT,
        warning: {
          minimumCount: SPURIOUS_WARNING_MINIMUM_COUNT,
          expectedRatio: SPURIOUS_WARNING_EXPECTED_RATIO,
          rule: "spurious >= minimumCount && (expected === 0 || spurious / expected > expectedRatio)",
        },
      },
    },
    spectral: {
      fftSize: FFT_SIZE,
      maxFrames: SPECTRAL_MAX_FRAMES,
      bandEdgesHz: [...SPECTRAL_BAND_EDGES_HZ],
    },
  };
}

function analyzeSignal(audio: StereoAudio): SignalAnalysis {
  checkStereo(audio);
  let peak = 0;
  let energy = 0;
  let clippedSamples = 0;
  let firstClippedFrame: number | null = null;

  for (let index = 0; index < audio.left.length; index++) {
    const left = audio.left[index]!;
    const right = audio.right[index]!;
    const absLeft = Math.abs(left);
    const absRight = Math.abs(right);
    peak = Math.max(peak, absLeft, absRight);
    energy += left * left + right * right;
    if (absLeft > CLIPPING_THRESHOLD) {
      clippedSamples++;
      firstClippedFrame ??= index;
    }
    if (absRight > CLIPPING_THRESHOLD) {
      clippedSamples++;
      firstClippedFrame ??= index;
    }
  }

  const rms = audio.left.length === 0 ? 0 : Math.sqrt(energy / (audio.left.length * 2));
  return {
    peak,
    peakDb: toDb(peak),
    rms,
    rmsDb: toDb(rms),
    clipping: {
      clipped: clippedSamples > 0,
      sampleCount: clippedSamples,
      firstSampleIndex: firstClippedFrame,
    },
    silent: peak < SILENCE_PEAK_THRESHOLD,
  };
}

function detectOnsets(audio: StereoAudio, sampleRate: number): number[] {
  checkStereo(audio);
  if (audio.left.length === 0) return [];
  const window = millisecondsToSamples(ONSET_WINDOW_MS, sampleRate);
  const hop = millisecondsToSamples(ONSET_HOP_MS, sampleRate);
  const refractory = millisecondsToSamples(ONSET_REFRACTORY_MS, sampleRate);
  const frameCount = Math.max(1, Math.ceil(audio.left.length / hop));
  const energies = new Float64Array(frameCount);
  const prefix = new Float64Array(audio.left.length + 1);

  for (let index = 0; index < audio.left.length; index++) {
    const left = audio.left[index]!;
    const right = audio.right[index]!;
    prefix[index + 1] = prefix[index]! + (left * left + right * right) / 2;
  }
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    const end = Math.min(audio.left.length, start + window);
    energies[frame] = end === start ? 0 : (prefix[end]! - prefix[start]!) / (end - start);
  }

  const lookbackFrames = baselineLookbackFrames(window, hop);
  const candidates: OnsetCandidate[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const current = energies[frame]!;
    let previous = 0;
    for (let index = frame - lookbackFrames; index < frame; index++) previous += frameEnergy(energies, index);
    previous /= lookbackFrames;
    const strength = Math.max(0, current - previous);
    const next = energies[Math.min(frameCount - 1, frame + 1)]!;
    if (
      Math.sqrt(current) >= ONSET_MIN_RMS &&
      current >= previous * ONSET_ENERGY_RISE_RATIO + ENERGY_FLOOR &&
      current >= next
    ) {
      candidates.push({ sample: frame * hop, strength });
    }
  }

  const detected: OnsetCandidate[] = [];
  for (const candidate of candidates) {
    const previous = detected.at(-1);
    if (previous === undefined || candidate.sample - previous.sample >= refractory) {
      detected.push(candidate);
    } else if (candidate.strength > previous.strength) {
      detected[detected.length - 1] = candidate;
    }
  }
  return detected.map((candidate) => candidate.sample);
}

function detectSpuriousOnsets(audio: StereoAudio, sampleRate: number): number[] {
  checkStereo(audio);
  if (audio.left.length === 0) return [];
  const window = millisecondsToSamples(SPURIOUS_ONSET_WINDOW_MS, sampleRate);
  const hop = millisecondsToSamples(ONSET_HOP_MS, sampleRate);
  const refractory = millisecondsToSamples(ONSET_REFRACTORY_MS, sampleRate);
  const timestampCompensation = spuriousTimestampCompensationSamples(hop);
  const frameCount = Math.max(1, Math.ceil(audio.left.length / hop));
  const peakEnergies = shortWindowPeakEnergies(audio, window, hop, frameCount);
  const lookbackFrames = baselineLookbackFrames(millisecondsToSamples(ONSET_WINDOW_MS, sampleRate), hop);
  const candidates: OnsetCandidate[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const current = peakEnergies[frame]!;
    const baseline = frameEnergy(peakEnergies, frame - lookbackFrames);
    const strength = Math.max(0, current - baseline);
    const nextFrame = Math.min(frameCount - 1, frame + 1);
    const nextBaseline = frameEnergy(peakEnergies, nextFrame - lookbackFrames);
    const nextStrength = Math.max(0, peakEnergies[nextFrame]! - nextBaseline);
    if (
      Math.sqrt(current) >= ONSET_MIN_RMS &&
      current >= baseline * SPURIOUS_ONSET_ENERGY_RISE_RATIO + ENERGY_FLOOR &&
      strength >= nextStrength
    ) {
      // Frame `frame` spans [(frame + 1) * hop - window, (frame + 1) * hop), so
      // the frame that first sees the risen envelope is the one whose window end
      // has just passed the transient's peak: that peak lies in the final hop,
      // [frame * hop, (frame + 1) * hop). Reporting the window end minus one hop
      // therefore lands inside the transient, at most one hop early and never
      // late. Subtracting half the window instead (the previous behaviour) put
      // every reported position a fixed 10 ms before the sound it points at.
      candidates.push({
        sample: (frame + 1) * hop - timestampCompensation,
        strength,
      });
    }
  }

  const detected: OnsetCandidate[] = [];
  for (const candidate of candidates) {
    const previous = detected.at(-1);
    if (previous === undefined || candidate.sample - previous.sample >= refractory) {
      detected.push(candidate);
    } else if (candidate.strength > previous.strength) {
      detected[detected.length - 1] = candidate;
    }
  }
  return detected.map((candidate) => candidate.sample);
}

function shortWindowPeakEnergies(
  audio: StereoAudio,
  window: number,
  hop: number,
  frameCount: number,
): Float64Array {
  const magnitudes = new Float64Array(audio.left.length);
  for (let index = 0; index < audio.left.length; index++) {
    magnitudes[index] = Math.max(Math.abs(audio.left[index]!), Math.abs(audio.right[index]!));
  }

  const energies = new Float64Array(frameCount);
  const deque: number[] = [];
  let head = 0;
  let addedUntil = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const end = Math.min(audio.left.length, (frame + 1) * hop);
    while (addedUntil < end) {
      while (deque.length > head && magnitudes[deque.at(-1)!]! <= magnitudes[addedUntil]!) deque.pop();
      deque.push(addedUntil++);
    }
    const start = Math.max(0, end - window);
    while (deque[head] !== undefined && deque[head]! < start) head++;
    const peak = deque[head] === undefined ? 0 : magnitudes[deque[head]!]!;
    energies[frame] = peak * peak;
  }
  return energies;
}

/**
 * Windows before the start of the buffer are silent, not missing. A render
 * begins from silence, so a frame index below zero contributes zero energy to a
 * baseline. Clamping to frame 0 instead lets a transient sitting in the very
 * first window become its own baseline, so no rise is ever seen and an onset at
 * sample 0 — a hit on beat 1, the most common onset there is — goes undetected
 * while the identical hit later in the buffer is found.
 */
function frameEnergy(energies: Float64Array, frame: number): number {
  return frame < 0 ? 0 : energies[frame]!;
}

/** A baseline looks back one analysis window's worth of hops. */
function baselineLookbackFrames(window: number, hop: number): number {
  return Math.max(1, Math.round(window / hop));
}

/** See the timestamp note in detectSpuriousOnsets: one hop back from the window end. */
function spuriousTimestampCompensationSamples(hop: number): number {
  return hop;
}

/** See SpuriousAttribution and SPURIOUS_MAX_ATTACK_LAG_MS. */
function spuriousAttribution(sampleRate: number, tolerance: number): SpuriousAttribution {
  return {
    earliestSamples: -tolerance,
    latestSamples: millisecondsToSamples(SPURIOUS_MAX_ATTACK_LAG_MS, sampleRate),
    maxAttackLagMs: SPURIOUS_MAX_ATTACK_LAG_MS,
    rule: "expected + earliestSamples <= candidate && candidate <= expected + latestSamples",
  };
}

function matchOnsets(
  expected: number[],
  detected: number[],
  spuriousCandidates: number[],
  tolerance: number,
  attribution: SpuriousAttribution,
): OnsetAnalysis {
  const used = new Set<number>();
  const offsets: number[] = [];
  const unmatched: number[] = [];

  for (const expectedSample of expected) {
    let bestIndex = -1;
    let bestDistance = tolerance + 1;
    for (let index = 0; index < detected.length; index++) {
      if (used.has(index)) continue;
      const distance = Math.abs(detected[index]! - expectedSample);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0 && bestDistance <= tolerance) {
      used.add(bestIndex);
      offsets.push(detected[bestIndex]! - expectedSample);
    } else if (unmatched.length < UNMATCHED_EXPECTED_LIMIT) {
      unmatched.push(expectedSample);
    }
  }

  const meanOffset = offsets.length === 0 ? 0 : offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const maxOffset = offsets.length === 0 ? 0 : Math.max(...offsets.map((value) => Math.abs(value)));
  const spuriousPositions = spuriousCandidates.filter(
    (candidate) =>
      !expected.some((expectedSample) => {
        const offset = candidate - expectedSample;
        return offset >= attribution.earliestSamples && offset <= attribution.latestSamples;
      }),
  );
  return {
    expected: expected.length,
    detected: offsets.length,
    matched: offsets.length,
    spurious: spuriousPositions.length,
    meanOffsetSamples: meanOffset,
    maxOffsetSamples: maxOffset,
    unmatchedExpected: unmatched,
    spuriousPositions: spuriousPositions.slice(0, SPURIOUS_POSITIONS_LIMIT),
  };
}

function shouldWarnForSpuriousOnsets(onsets: OnsetAnalysis): boolean {
  return (
    onsets.spurious >= SPURIOUS_WARNING_MINIMUM_COUNT &&
    (onsets.expected === 0 || onsets.spurious / onsets.expected > SPURIOUS_WARNING_EXPECTED_RATIO)
  );
}

function analyzeSpectrum(audio: StereoAudio, sampleRate: number): SpectralAnalysis {
  checkStereo(audio);
  const bands = SPECTRAL_BAND_EDGES_HZ.slice(0, -1).map((minHz, index) => ({
    minHz,
    maxHz: SPECTRAL_BAND_EDGES_HZ[index + 1]!,
    energy: 0,
  }));
  if (audio.left.length === 0 || audio.left.length < FFT_SIZE) {
    return { centroidHz: 0, bands: bands.map(({ minHz, maxHz }) => ({ minHz, maxHz, share: 0 })) };
  }

  const starts = loudestFrameStarts(audio);
  let weightedFrequency = 0;
  let centroidEnergy = 0;
  for (const start of starts) {
    const leftReal = new Float64Array(FFT_SIZE);
    const leftImag = new Float64Array(FFT_SIZE);
    const rightReal = new Float64Array(FFT_SIZE);
    const rightImag = new Float64Array(FFT_SIZE);
    for (let index = 0; index < FFT_SIZE; index++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
      leftReal[index] = audio.left[start + index]! * window;
      rightReal[index] = audio.right[start + index]! * window;
    }
    fft(leftReal, leftImag);
    fft(rightReal, rightImag);
    for (let bin = 1; bin <= FFT_SIZE / 2; bin++) {
      const frequency = (bin * sampleRate) / FFT_SIZE;
      const energy =
        leftReal[bin]! ** 2 + leftImag[bin]! ** 2 + rightReal[bin]! ** 2 + rightImag[bin]! ** 2;
      weightedFrequency += frequency * energy;
      centroidEnergy += energy;
      const band = bands.find((candidate) => frequency >= candidate.minHz && frequency < candidate.maxHz);
      if (band !== undefined) band.energy += energy;
    }
  }

  const bandEnergy = bands.reduce((sum, band) => sum + band.energy, 0);
  return {
    centroidHz: centroidEnergy <= ENERGY_FLOOR ? 0 : weightedFrequency / centroidEnergy,
    bands: bands.map(({ minHz, maxHz, energy }) => ({
      minHz,
      maxHz,
      share: bandEnergy <= ENERGY_FLOOR ? 0 : energy / bandEnergy,
    })),
  };
}

function loudestFrameStarts(audio: StereoAudio): number[] {
  const candidates: { start: number; energy: number }[] = [];
  for (let start = 0; start + FFT_SIZE <= audio.left.length; start += FFT_SIZE) {
    let energy = 0;
    for (let index = start; index < start + FFT_SIZE; index++) {
      const left = audio.left[index]!;
      const right = audio.right[index]!;
      energy += left * left + right * right;
    }
    candidates.push({ start, energy });
  }
  candidates.sort((left, right) => right.energy - left.energy || left.start - right.start);
  return candidates.slice(0, SPECTRAL_MAX_FRAMES).map((candidate) => candidate.start);
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    for (; (reversed & bit) !== 0; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed]!, real[index]!];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < length / 2; index++) {
        const even = offset + index;
        const odd = even + length / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function millisecondsToSamples(milliseconds: number, sampleRate: number): number {
  return Math.max(1, Math.round((milliseconds / 1_000) * sampleRate));
}

function toDb(value: number): number | null {
  return value === 0 ? null : 20 * Math.log10(value);
}

function checkStereo(audio: StereoAudio): void {
  if (audio.left.length !== audio.right.length) {
    throw new Error("cannot analyze: left and right channel lengths differ");
  }
}

function formatMetric(value: number): string {
  return value.toPrecision(6);
}
