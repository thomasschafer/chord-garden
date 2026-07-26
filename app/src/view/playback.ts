import { samplesPerTick } from "@chord-garden/engine/compiler";
import type { Project } from "@chord-garden/format/pure";
import type { PlayerStatus } from "../audio/livePlayer";

/**
 * Where the transport is, in the terms an editor draws in.
 *
 * The conversion from samples to ticks is the compiler's `samplesPerTick`, not a
 * local division: a playhead that computes tempo its own way drifts away from the
 * audio it claims to track, and slowly enough that it looks like an engine bug.
 */
export function songTickAt(project: Project, sampleRate: number, positionSample: number): number {
  const perTick = samplesPerTick(project, sampleRate);
  if (perTick <= 0) throw new Error(`cannot place the playhead: ${perTick} samples per tick is not positive`);
  return positionSample / perTick;
}

export interface PatternPlayhead {
  /** Ticks from the start of the pattern; fractional, because it is a playhead. */
  localTick: number;
  /** Which repetition of the clip is sounding, zero-based. */
  repeatIndex: number;
  clipStartTick: number;
}

/**
 * The playhead inside one pattern, or `undefined` when no clip of that pattern is
 * playing on that track right now.
 *
 * A pattern is not a timeline position — it is played by clips, possibly several,
 * possibly repeated (docs/format-spec.md §7) — so "where is the playhead in this
 * pattern" only has an answer through the arrangement. The first matching clip
 * wins; two clips of one pattern overlapping on one track is a legal document, and
 * drawing two playheads is more confusing than drawing the earlier one.
 */
/**
 * Where a transport status puts the playhead inside one pattern of one track:
 * everything `PatternPlayhead` has to get right, with no React in the way.
 *
 * `undefined` covers all three ways there is nothing to draw — the transport is not
 * playing, it has no sample rate yet, or no clip of this pattern is sounding on this
 * track — because they are one question to a caller ("is there a line, and where").
 */
export function livePatternTick(
  project: Project,
  trackId: string,
  patternId: string,
  status: PlayerStatus,
): number | undefined {
  if (status.phase !== "playing" || status.sampleRate === null) return undefined;
  const songTick = songTickAt(project, status.sampleRate, status.positionSample);
  return patternPlayhead(project, trackId, patternId, songTick)?.localTick;
}

export function patternPlayhead(
  project: Project,
  trackId: string,
  patternId: string,
  songTick: number,
): PatternPlayhead | undefined {
  const pattern = project.patterns.get(patternId);
  if (pattern === undefined) return undefined;
  const length = pattern.lengthTicks;
  if (length <= 0) throw new Error(`pattern "${patternId}" has a length of ${length} ticks`);
  for (const clip of project.arrangement.clips) {
    if (clip.track !== trackId || clip.pattern !== patternId) continue;
    const offset = songTick - clip.startTick;
    if (offset < 0 || offset >= length * clip.repeatCount) continue;
    return {
      localTick: offset % length,
      repeatIndex: Math.floor(offset / length),
      clipStartTick: clip.startTick,
    };
  }
  return undefined;
}
