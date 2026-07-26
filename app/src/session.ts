import { ProjectClient, WriteConflict } from "@chord-garden/dev-server/client";
import { connectAudioToDocument } from "./audio/documentBridge";
import { LivePlayer } from "./audio/livePlayer";
import {
  createDocumentStore,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
} from "./store/documentStore";

/**
 * The one project this window is editing, and the wiring around it.
 *
 * Kept out of React: the store, the client and the audio engine all outlive any
 * component, and PLAN.md §10 puts the document store — not a component tree — at
 * the centre with the UI and the audio engine reading from it.
 */

/** `?project=<name>` selects a mounted project; the fixture is the default. */
export const projectName = new URLSearchParams(window.location.search).get("project") ?? "first-track";

/** `?seed=<n>` matches `musictool render --seed` so the UI and CLI agree. */
export const seed = Number(new URLSearchParams(window.location.search).get("seed") ?? "0");

export const client = ProjectClient.fromPage(window as unknown as Record<string, unknown>);

const sink: DocumentSink = {
  async write(files) {
    try {
      const response = await client.write(projectName, files);
      return { diagnostics: response.summary.diagnostics };
    } catch (error) {
      // Translated at the boundary, so the store depends on its own contract
      // rather than on the transport's.
      if (error instanceof WriteConflict) throw new WriteConflictError(error.message, error.paths);
      throw error;
    }
  },
};

export const documentStore: DocumentStore = createDocumentStore({ sink });

/**
 * The one player for this window, and its link to the document.
 *
 * Module scope rather than a component's `useMemo`: an `AudioContext` is a scarce
 * per-page resource, and the bridge below has to exist whether or not any
 * particular editor is mounted.
 */
export const livePlayer = new LivePlayer("/worklet.js", (path) => client.asset(projectName, path));

connectAudioToDocument(documentStore, livePlayer);

/**
 * Fetch the project and hand it to the store.
 *
 * Also the conflict recovery path: re-opening replaces the model with what is
 * actually on disk and clears the conflict. That discards local edits, which is
 * why nothing calls it behind the human's back — merging those edits with the
 * external ones is Phase 4's reconcile work, and a wrong guess loses real work.
 */
export async function loadProjectIntoStore(): Promise<void> {
  const loaded = await client.loadProject(projectName);
  documentStore.getState().open({
    project: loaded.project,
    texts: loaded.texts,
    diagnostics: loaded.summary.diagnostics,
  });
}
