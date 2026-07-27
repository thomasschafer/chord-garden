import type { Project } from "./model.js";
import { ticksPerBar } from "./musicTime.js";
import { parseSteps } from "./pattern.js";
import { pitchToMidi } from "./pitch.js";

export interface DescribeTrack {
  id: string;
  type: string;
  instrument: string;
  patterns: string[];
  clipCount: number;
  automatedParams: string[];
  /**
   * The effect chain in signal order, present only when the track has one.
   *
   * Omitted rather than reported as `[]` so a project with no effects describes
   * exactly as it did before effects existed — the golden report of a format-1
   * project is a contract, and an empty array in every track would break it to
   * say nothing.
   */
  effects?: { id: string; type: string }[];
}

export interface DescribePattern {
  id: string;
  kind: string;
  bars: number;
  /** Grid patterns: hits per lane. */
  lanes?: { lane: string; hits: number }[];
  /** Notes patterns: note count and pitch range. */
  noteCount?: number;
  pitchRange?: [string, string];
}

export interface DescribeReport {
  name: string;
  format: number;
  ppqn: number;
  /** bpm×100, as persisted. */
  bpm: number;
  timeSignature: [number, number];
  key: { root: string; scale: string } | null;
  swing: number;
  lengthTicks: number;
  bars: number;
  tracks: DescribeTrack[];
  patterns: DescribePattern[];
}

/** Machine-readable project summary; `describe --json` golden tests assert on it. */
export function describeProject(project: Project): DescribeReport {
  const meter = project.project.meterMap[0]!;
  const barTicks = ticksPerBar(project.project.ppqn, meter.timeSignature);

  const tracks: DescribeTrack[] = project.project.trackOrder.map((id) => {
    const track = project.tracks.get(id)!;
    const described: DescribeTrack = {
      id,
      type: track.type,
      instrument: track.instrument,
      patterns: track.patterns,
      clipCount: project.arrangement.clips.filter((c) => c.track === id).length,
      automatedParams: project.automation.get(id)?.lanes.map((l) => l.param) ?? [],
    };
    if (track.effects !== undefined && track.effects.length > 0) {
      described.effects = track.effects.map((effect) => ({ id: effect.id, type: effect.type }));
    }
    return described;
  });

  const patterns: DescribePattern[] = [...project.patterns.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((pattern) => {
      const bars = pattern.lengthTicks / barTicks;
      if (pattern.kind === "grid") {
        return {
          id: pattern.id,
          kind: pattern.kind,
          bars,
          lanes: pattern.lanes.map((lane) => ({
            lane: lane.lane,
            hits:
              parseSteps(lane.steps, {
                file: "",
                pointer: "",
                stepsPerBar: lane.grid.stepsPerBar,
                bars,
              }).hits?.length ?? 0,
          })),
        };
      }
      const sorted = [...pattern.notes].sort((a, b) => (pitchToMidi(a.pitch) ?? 0) - (pitchToMidi(b.pitch) ?? 0));
      const report: DescribePattern = { id: pattern.id, kind: pattern.kind, bars, noteCount: pattern.notes.length };
      if (sorted.length > 0) {
        report.pitchRange = [sorted[0]!.pitch, sorted[sorted.length - 1]!.pitch];
      }
      return report;
    });

  return {
    name: project.project.name,
    format: project.project.format,
    ppqn: project.project.ppqn,
    bpm: project.project.tempoMap[0]!.bpm,
    timeSignature: meter.timeSignature,
    key: project.project.key ?? null,
    swing: project.project.swing,
    lengthTicks: project.arrangement.lengthTicks,
    bars: project.arrangement.lengthTicks / barTicks,
    tracks,
    patterns,
  };
}
