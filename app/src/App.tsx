import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { PlayerStatus } from "./audio/livePlayer";
import { PatternEditors } from "./components/PatternEditors";
import { ProjectHeader } from "./components/ProjectHeader";
import { TrackList } from "./components/TrackList";
import { Transport } from "./components/Transport";
import { WriteStatus } from "./components/WriteStatus";
import { documentStore, loadProjectIntoStore, projectName } from "./session";
import { songTickAt } from "./view/playback";

/**
 * Stage 2 of the Phase 3 UI: the step sequencer and the piano roll, on top of stage
 * 1's store, write path and transport.
 *
 * The playhead is lifted to here because it is one fact — where the transport is —
 * that every editor needs, and threading it from the transport's status is cheaper
 * than each editor subscribing to the audio engine separately.
 */
export function App(): React.JSX.Element {
  const project = useStore(documentStore, (state) => state.project);
  const [error, setError] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState<{ positionSample: number; sampleRate: number } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    loadProjectIntoStore().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onStatus = useCallback((status: PlayerStatus) => {
    setPlaying(
      status.phase === "playing" && status.sampleRate !== null
        ? { positionSample: status.positionSample, sampleRate: status.sampleRate }
        : undefined,
    );
  }, []);

  if (error !== undefined) {
    return (
      <main>
        <h1>chord-garden</h1>
        <p className="error">could not open &quot;{projectName}&quot;: {error}</p>
      </main>
    );
  }

  if (project === undefined) {
    return (
      <main>
        <h1>chord-garden</h1>
        <p className="muted">loading {projectName}…</p>
      </main>
    );
  }

  const songTick = playing === undefined ? undefined : songTickAt(project, playing.sampleRate, playing.positionSample);

  return (
    <main>
      <h1>chord-garden — {project.project.name}</h1>
      <p className="muted">{project.root}</p>
      <ProjectHeader project={project} />
      <Transport project={project} onStatus={onStatus} />
      <PatternEditors project={project} songTick={songTick} />
      <TrackList project={project} />
      <WriteStatus />
    </main>
  );
}
