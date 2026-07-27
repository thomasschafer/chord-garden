import type { Project } from "@chord-garden/format";
import type { CompiledSchedule } from "../compiler.js";
import type { LiveSampleRef, LiveTrackConfig } from "./protocol.js";

export interface LiveGraph {
  /** One entry per compiled track, in `trackOrder`; slice `trackIndex` indexes it. */
  tracks: LiveTrackConfig[];
  samples: LiveSampleRef[];
}

/** Project-relative sample paths the schedule's instruments need, in kit order. */
export function requiredSamplePaths(project: Project, schedule: CompiledSchedule): string[] {
  const paths: string[] = [];
  for (const track of schedule.tracks) {
    const instrument = project.instruments.get(track.instrumentId);
    if (instrument === undefined) {
      throw new Error(`cannot configure live engine: instrument "${track.instrumentId}" is missing`);
    }
    if (instrument.type !== "drumkit") continue;
    for (const voice of Object.values(instrument.kit)) {
      if (!paths.includes(voice.sample)) paths.push(voice.sample);
    }
  }
  return paths;
}

/**
 * The configure payload for a compiled schedule.
 *
 * `hashOf` supplies each sample's content hash, which the worklet checks against
 * what it holds: a configure that names content the worklet has not been sent is
 * rejected rather than played with whatever was there before.
 */
export function liveGraph(
  project: Project,
  schedule: CompiledSchedule,
  hashOf: (path: string) => string,
): LiveGraph {
  const tracks = schedule.tracks.map((track): LiveTrackConfig => {
    const instrument = project.instruments.get(track.instrumentId);
    if (instrument === undefined) {
      throw new Error(`cannot configure live engine: instrument "${track.instrumentId}" is missing`);
    }
    return { trackId: track.trackId, instrument, effects: track.effects, automation: track.automation };
  });
  const samples = requiredSamplePaths(project, schedule).map((path) => ({ path, contentHash: hashOf(path) }));
  return { tracks, samples };
}
