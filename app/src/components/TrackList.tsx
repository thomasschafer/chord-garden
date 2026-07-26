import { ticksPerBar, type PatternDoc, type Project } from "@chord-garden/format/pure";

/**
 * The tracks of the project, each with its instrument and its patterns.
 *
 * Read-only in stage 1: the step sequencer and piano roll that make patterns
 * editable are stage 2, and this is the surface they will replace. It exists to
 * show that the whole bundle — tracks, instruments, patterns — really did load
 * into the model, in `trackOrder`.
 */
export function TrackList({ project }: { project: Project }): React.JSX.Element {
  const barTicks = ticksPerBar(project.project.ppqn, project.project.meterMap[0]!.timeSignature);

  return (
    <section>
      <h2>tracks</h2>
      <table>
        <thead>
          <tr>
            <th>track</th>
            <th>type</th>
            <th>instrument</th>
            <th>patterns</th>
            <th>clips</th>
          </tr>
        </thead>
        <tbody>
          {project.project.trackOrder.map((trackId) => {
            const track = project.tracks.get(trackId);
            if (track === undefined) {
              return (
                <tr key={trackId}>
                  <td>{trackId}</td>
                  <td colSpan={4} className="error">
                    listed in trackOrder but no tracks/{trackId}.json was loaded
                  </td>
                </tr>
              );
            }
            const instrument = project.instruments.get(track.instrument);
            const clips = project.arrangement.clips.filter((clip) => clip.track === trackId);
            return (
              <tr key={trackId}>
                <td>{track.id}</td>
                <td>{track.type}</td>
                <td>
                  {track.instrument}
                  <br />
                  <span className="muted">{describeInstrument(project, track.instrument)}</span>
                </td>
                <td>
                  {track.patterns.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <ul>
                      {track.patterns.map((patternId) => (
                        <li key={patternId}>
                          {patternId} <span className="muted">{describePattern(project.patterns.get(patternId), barTicks)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {clips.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    clips
                      .map((clip) => `${clip.pattern}×${clip.repeatCount} @ bar ${clip.startTick / barTicks + 1}`)
                      .join(", ")
                  )}
                  {instrument === undefined && <span className="error"> instrument missing</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function describeInstrument(project: Project, id: string): string {
  const instrument = project.instruments.get(id);
  if (instrument === undefined) return "missing";
  if (instrument.type === "synth") return `synth, ${instrument.engine}`;
  const voices = Object.keys(instrument.kit).sort();
  return `drumkit, ${voices.length} voices: ${voices.join(", ")}`;
}

function describePattern(pattern: PatternDoc | undefined, barTicks: number): string {
  if (pattern === undefined) return "missing";
  const bars = pattern.lengthTicks / barTicks;
  if (pattern.kind === "grid") {
    return `grid, ${bars} bar(s), ${pattern.lanes.length} lane(s): ${pattern.lanes.map((lane) => lane.lane).join(", ")}`;
  }
  return `notes, ${bars} bar(s), ${pattern.notes.length} note(s)`;
}
