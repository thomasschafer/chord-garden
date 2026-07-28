import type { Project } from "./model.js";
import { ticksPerBar } from "./musicTime.js";
import { parseSteps } from "./pattern.js";
import { pitchToMidi } from "./pitch.js";

export interface DescribedTrack {
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

/**
 * A track `project.json`'s `trackOrder` names that has no `tracks/<id>.json`.
 *
 * It keeps its place in the list rather than being dropped, because `describe`'s
 * job here is to show the project as it is: a report that silently omitted it
 * would disagree with `project.json` about how many tracks the project has, and
 * an agent comparing the two would be told nothing about the one that is wrong.
 * `musictool validate` reports the same thing as `trackorder.unknown-track`.
 */
export interface MissingTrack {
  id: string;
  /** Always `true`, and the discriminant; a track that exists has no such key. */
  missing: true;
}

export type DescribeTrack = DescribedTrack | MissingTrack;

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

/**
 * Machine-readable project summary; `describe --json` golden tests assert on it.
 *
 * **Total over any assembled project, including one that does not validate.**
 * `describe` is a read-only inspection command, and an agent reaches for it
 * precisely when something is wrong — so it summarises what it can and marks what
 * it cannot, rather than refusing. A reader that switches itself off exactly when
 * the project is broken is a reader that is never there when it is wanted, and
 * `musictool validate` already exists for the yes/no answer. Contrast `fmt`, which
 * does refuse: it *writes*, and writing over a project nobody can parse is how an
 * edit is lost. Writers refuse, readers report.
 *
 * That is not a new policy — `runDescribe` already prints the diagnostics after the
 * report and already exits 1 when the project is invalid. The crash this guards
 * against was a missing case, not a missing decision.
 *
 * `meterMap[0]` and `tempoMap[0]` are still asserted: both are `required` with
 * `minItems: 1` in `project.schema.json`, and a schema error stops `loadProject`
 * before a `Project` is ever assembled, so unlike `trackOrder` they cannot be
 * reached from a document on disk.
 */
export function describeProject(project: Project): DescribeReport {
  const meter = project.project.meterMap[0]!;
  const barTicks = ticksPerBar(project.project.ppqn, meter.timeSignature);

  const tracks: DescribeTrack[] = project.project.trackOrder.map((id) => {
    const track = project.tracks.get(id);
    // Semantic, not schema: `trackorder.unknown-track` is reported by
    // `semanticValidate`, which runs *after* the project is assembled, so a
    // project reaching here can name a track that does not exist.
    if (track === undefined) return { id, missing: true };
    const described: DescribedTrack = {
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
