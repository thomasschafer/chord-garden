import type { Project } from "@chord-garden/format/pure";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LivePlayer, type PlayerStatus } from "../audio/livePlayer";
import { client, projectName, seed } from "../session";

/**
 * Play/stop and a position readout driven by the live engine.
 *
 * The start button is the user gesture the browser requires before an
 * `AudioContext` may make sound (PLAN.md §14), so it is the literal entry point
 * to audio rather than something the app attempts on load and recovers from.
 */
export function Transport({ project }: { project: Project }): React.JSX.Element {
  const player = useMemo(
    () => new LivePlayer("/worklet.js", (path) => client.asset(projectName, path)),
    [],
  );
  const [status, setStatus] = useState<PlayerStatus>(() => player.getStatus());

  useEffect(() => player.subscribe(setStatus), [player]);

  const start = useCallback(() => {
    void player.start(project, seed);
  }, [player, project]);

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
        <button type="button" onClick={() => player.stop()} disabled={status.phase !== "playing"}>
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
      </div>
      {status.error !== undefined && <p className="error">audio error: {status.error}</p>}
    </section>
  );
}
