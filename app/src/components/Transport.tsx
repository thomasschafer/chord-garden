import type { Project } from "@chord-garden/format/pure";
import { useCallback, useEffect, useState } from "react";
import type { PlayerStatus } from "../audio/livePlayer";
import { livePlayer, seed } from "../session";

/**
 * Play/stop and a position readout driven by the live engine.
 *
 * The start button is the user gesture the browser requires before an
 * `AudioContext` may make sound (PLAN.md §14), so it is the literal entry point
 * to audio rather than something the app attempts on load and recovers from.
 *
 * The player itself lives in `session.ts`, not here: the editors' changes reach it
 * through the document store (see `audio/documentBridge.ts`), which has to work
 * whether or not this component happens to be mounted.
 *
 * This readout re-renders on every worklet report, which is what a readout of a
 * moving position is for. It passes none of it on: it is a leaf, and the playhead
 * inside each editor subscribes to the player separately so that a position never
 * travels through a component that has editors underneath it.
 */
export function Transport({ project }: { project: Project }): React.JSX.Element {
  const [status, setStatus] = useState<PlayerStatus>(() => livePlayer.getStatus());

  useEffect(() => livePlayer.subscribe(setStatus), []);

  const start = useCallback(() => {
    void livePlayer.start(project, seed);
  }, [project]);

  const rate = status.sampleRate ?? 0;
  const seconds = rate === 0 ? 0 : status.positionSample / rate;
  const total = rate === 0 ? 0 : status.totalSamples / rate;

  return (
    <section>
      <h2>transport</h2>
      <p>
        <button type="button" onClick={start} disabled={status.phase === "starting" || status.phase === "playing"}>
          {status.phase === "idle" ? "click to start audio" : "play"}
        </button>{" "}
        <button type="button" onClick={() => livePlayer.stop()} disabled={status.phase !== "playing"}>
          stop
        </button>
      </p>
      <div className="status">
        <span>phase</span>
        <span>{status.phase}</span>
        <span>position</span>
        <span>
          {seconds.toFixed(2)} s / {total.toFixed(2)} s (sample {status.positionSample} of {status.totalSamples})
        </span>
        <span>sample rate</span>
        <span>{status.sampleRate === null ? "-" : `${status.sampleRate} Hz`}</span>
        <span>active voices</span>
        <span>{status.activeVoices}</span>
        <span>underrun blocks</span>
        <span>{status.underrunBlocks}</span>
        <span>peak (now)</span>
        <span>{status.peak.toFixed(4)}</span>
        <span>peak (session)</span>
        <span>
          {status.peakSession.toFixed(4)}
          {status.reports > 0 &&
            ` — ${status.reportsWithSound} of ${status.reports} reports carried signal`}
        </span>
        <span>live edits</span>
        <span>{describeEdits(status)}</span>
        <span>samples reloaded</span>
        <span>{describeSamples(status)}</span>
      </div>
      {status.error !== undefined && <p className="error">audio error: {status.error}</p>}
    </section>
  );
}

/**
 * What the engine did with the edits made since the transport was loaded.
 *
 * Worth showing rather than inferring by ear: PLAN.md §12 step 6 defers a
 * structural change to a bar line, so between the click and the bar the file and the
 * sound genuinely disagree, and a person who cannot see that reasonably concludes
 * the edit did not work.
 */
/**
 * Which sample files have been re-read from disk while this run has been playing.
 *
 * The one change with no visible cause anywhere else in the app: replacing
 * `samples/kick.wav` moves nothing in the editors, so without this the sound changes
 * and the screen says nothing about why. A replacement is adopted by the next hit of
 * that voice, so it is audible within a step rather than at a bar line.
 */
function describeSamples(status: PlayerStatus): string {
  if (status.samplesReloaded.length === 0) return "none since play started";
  const [latest, ...earlier] = status.samplesReloaded;
  return earlier.length === 0 ? `${latest}` : `${latest} (and ${earlier.length} more)`;
}

function describeEdits(status: PlayerStatus): string {
  if (status.phase === "idle") return "press play; edits made now are in the model the engine will compile";
  if (status.lastEdit === undefined) return `${status.editsApplied} applied`;
  const { effect, bar, atSample } = status.lastEdit;
  const when = atSample === null ? "applied immediately" : `queued for bar ${bar} (sample ${atSample})`;
  return `${status.editsApplied} applied — last was ${effect}, ${when}`;
}
