import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { ProjectHeader } from "./components/ProjectHeader";
import { TrackList } from "./components/TrackList";
import { Transport } from "./components/Transport";
import { WriteStatus } from "./components/WriteStatus";
import { documentStore, loadProjectIntoStore, projectName } from "./session";

/**
 * Stage 1 of the Phase 3 UI: load a project into the document store, show what
 * it contains, play it, and prove that an edit reaches the file on disk.
 *
 * The step sequencer and piano roll are stage 2. What is here is the foundation
 * they sit on — the store, the write path, and the transport — plus enough of a
 * view to see that all three work.
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
      <TrackList project={project} />
      <Transport project={project} />
      <WriteStatus />
    </main>
  );
}
