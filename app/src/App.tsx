import { useEffect } from "react";
import { useStore } from "zustand";
import { AutomationEditors } from "./components/AutomationEditor";
import { InstrumentEditors } from "./components/InstrumentEditor";
import { Mixer } from "./components/Mixer";
import { PatternEditors } from "./components/PatternEditors";
import { ProjectHeader } from "./components/ProjectHeader";
import { SyncStatus } from "./components/SyncStatus";
import { TrackList } from "./components/TrackList";
import { Transport } from "./components/Transport";
import { WriteStatus } from "./components/WriteStatus";
import { documentStore, projectName, startSession, syncStore } from "./session";

/**
 * Stage 2 of the Phase 3 UI, now opened through the Phase 4 sync session: the step
 * sequencer and the piano roll, on top of the store, write path and transport.
 *
 * The project is not loaded here any more. `startSession` connects the sidecar
 * socket and loads the project once that socket is live, because loading first
 * leaves a window in which an external edit is announced to nobody and then never
 * repeated (see `session.ts`).
 *
 * Deliberately not here: the playback position. It changes about 47 times a second,
 * so anything holding it re-renders everything below it at that rate, and the editor
 * tree below is exactly what must stay still while a note is being placed. The one
 * component that needs the position — the playhead line inside each editor — reads
 * the player itself (`components/Playhead.tsx`).
 */
export function App(): React.JSX.Element {
  const project = useStore(documentStore, (state) => state.project);
  const rejected = useStore(syncStore, (state) => state.rejected);
  const loadError = useStore(syncStore, (state) => state.loadError);

  useEffect(() => {
    startSession();
  }, []);

  if (rejected !== undefined) {
    // PLAN.md §12's single-writer rule, as the human meets it. Refusing to open
    // at all is the point: two windows holding optimistic unsaved state is what
    // makes last-writer-wins dishonest.
    return (
      <main>
        <h1>chord-garden</h1>
        <p className="error">
          {rejected.kind === "alreadyOpen"
            ? `"${projectName}" is already open in another window. Close that one and reload this page — one window edits a project at a time.`
            : `the sidecar refused this window: ${rejected.message}`}
        </p>
      </main>
    );
  }

  if (loadError !== undefined) {
    return (
      <main>
        <h1>chord-garden</h1>
        <p className="error">could not open &quot;{projectName}&quot;: {loadError}</p>
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
      <Mixer project={project} />
      <PatternEditors project={project} />
      <AutomationEditors project={project} />
      <InstrumentEditors project={project} />
      <TrackList project={project} />
      <SyncStatus />
      <WriteStatus />
    </main>
  );
}
