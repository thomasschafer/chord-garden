import type { Project } from "@chord-garden/format/pure";
import { PianoRoll } from "./PianoRoll";
import { StepSequencer } from "./StepSequencer";

/**
 * Every pattern of the project, each in the editor its kind calls for, grouped by
 * the track that plays it.
 *
 * Reached through tracks rather than by listing `project.patterns` because a
 * pattern's meaning depends on its track: a grid lane is a voice of *that track's*
 * kit (docs/format-spec.md §5), and the playhead is only defined through the clips
 * of that track. A pattern no track references is an `orphan.pattern` diagnostic and
 * is deliberately not editable here — there is no kit to interpret it against.
 *
 * The track and pattern identify the playhead; they do not locate it. Each editor's
 * own `PatternPlayhead` reads the transport, so nothing on this path re-renders when
 * the transport moves — only when the document changes.
 */
export function PatternEditors({ project }: { project: Project }): React.JSX.Element {
  return (
    <section>
      <h2>patterns</h2>
      {project.project.trackOrder.map((trackId) => {
        const track = project.tracks.get(trackId);
        if (track === undefined) return null;
        return track.patterns.map((patternId) => {
          const pattern = project.patterns.get(patternId);
          if (pattern === undefined) {
            return (
              <p key={`${trackId}/${patternId}`} className="error">
                track &quot;{trackId}&quot; names pattern &quot;{patternId}&quot;, which did not load
              </p>
            );
          }
          const instrument = project.instruments.get(track.instrument);
          return (
            <div key={`${trackId}/${patternId}`}>
              <h3>
                {trackId} <span className="muted">/ {patternId}</span>
              </h3>
              {pattern.kind === "grid" ? (
                instrument === undefined || instrument.type !== "drumkit" ? (
                  <p className="error">
                    grid pattern &quot;{patternId}&quot; is played by track &quot;{trackId}&quot;, whose instrument is
                    not a drumkit, so its lanes name no voices
                  </p>
                ) : (
                  <StepSequencer project={project} trackId={trackId} pattern={pattern} kit={instrument} />
                )
              ) : (
                <PianoRoll project={project} trackId={trackId} pattern={pattern} />
              )}
            </div>
          );
        });
      })}
    </section>
  );
}
