import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { PatternEditors } from "./components/PatternEditors";
import { ProjectHeader } from "./components/ProjectHeader";
import { TrackList } from "./components/TrackList";
import { Transport } from "./components/Transport";
import { WriteStatus } from "./components/WriteStatus";
import { documentStore, loadProjectIntoStore, projectName } from "./session";

/**
 * Stage 2 of the Phase 3 UI: the step sequencer and the piano roll, on top of stage
 * 1's store, write path and transport.
 *
 * Deliberately not here: the playback position. It changes about 47 times a second,
 * so anything holding it re-renders everything below it at that rate, and the editor
 * tree below is exactly what must stay still while a note is being placed. The one
 * component that needs the position — the playhead line inside each editor — reads
 * the player itself (`components/Playhead.tsx`). What is left in this component's
 * state is the two facts that genuinely belong to the whole page: which project is
 * open, and whether it opened at all.
 */
export function App(): React.JSX.Element {
  const project = useStore(documentStore, (state) => state.project);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    loadProjectIntoStore().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
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

  return (
    <main>
      <h1>chord-garden — {project.project.name}</h1>
      <p className="muted">{project.root}</p>
      <ProjectHeader project={project} />
      <Transport project={project} />
      <PatternEditors project={project} />
      <TrackList project={project} />
      <WriteStatus />
    </main>
  );
}
