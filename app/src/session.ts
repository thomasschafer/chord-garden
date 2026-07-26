import { ProjectClient, WriteConflict } from "@chord-garden/dev-server/client";
import { ProjectSocket, type SyncTransportFactory } from "@chord-garden/dev-server/socket";
import { connectAudioToDocument } from "./audio/documentBridge";
import { LivePlayer } from "./audio/livePlayer";
import {
  createDocumentStore,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
} from "./store/documentStore";
import { createSyncStore, type SyncStore } from "./store/syncStore";

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
 * Also the recovery path of last resort: re-opening replaces the model with what
 * is actually on disk and clears every conflict and desync flag. That discards
 * unsaved local edits, which is why it is only called where nothing is unsaved,
 * or by a human pressing a button that says so.
 */
export async function loadProjectIntoStore(): Promise<void> {
  const loaded = await client.loadProject(projectName);
  documentStore.getState().open({
    project: loaded.project,
    texts: loaded.texts,
    diagnostics: loaded.summary.diagnostics,
  });
}

export const syncStore: SyncStore = createSyncStore();

/**
 * A real `WebSocket`, wired to the transport-shaped hole in `ProjectSocket`.
 *
 * This is the only place in the app that knows a WebSocket exists. The protocol
 * itself lives in the dev-server package beside the server it talks to, so the
 * two halves cannot drift, and it stays testable in Node.
 */
const transport: SyncTransportFactory = (path, handlers) => {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.open());
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") handlers.text(event.data);
    else handlers.failed("the sidecar sent a binary frame, which this protocol does not use");
  });
  socket.addEventListener("close", (event) => handlers.closed(event.code, event.reason));
  socket.addEventListener("error", () => handlers.failed("the sync socket failed"));
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
};

/**
 * The live link to the sidecar: the other half of PLAN.md §3's claim that a human
 * in this window and an agent editing files are two editors of one document.
 *
 * The order matters. Every connection — the first and every reconnect — loads the
 * project over HTTP *after* the socket is live, never before. A change that lands
 * between a load and a connect would be announced to a socket that did not exist
 * yet and would then never be re-announced, because the sidecar reports
 * differences from what it last established, not a full history. Connecting first
 * makes that gap impossible: anything earlier is in the load, anything later is a
 * push.
 */
export const projectSocket = new ProjectSocket({
  project: projectName,
  token: client.sessionToken,
  factory: transport,
  handlers: {
    ready(reconnected) {
      syncStore.setState({ connection: "live", detail: undefined });
      if (reconnected && documentStore.getState().dirty.length > 0) {
        // Reloading would throw the unsaved edits away, and this window cannot
        // know what happened on disk while it was gone. Both facts are the
        // human's to resolve; the write preconditions will refuse anything unsafe
        // in the meantime.
        syncStore.setState({
          behind:
            "the connection came back, but this window has unsaved edits and may have missed changes on disk while it was disconnected",
        });
        return;
      }
      syncStore.setState({ behind: undefined });
      loadProjectIntoStore().catch((error: unknown) => {
        syncStore.setState({ loadError: error instanceof Error ? error.message : String(error) });
      });
    },
    changed(message) {
      documentStore.getState().applyExternalChange(message);
    },
    invalid(message) {
      documentStore.getState().noteDiskInvalid(message.diagnostics);
    },
    rejected(rejection) {
      syncStore.setState({ rejected: rejection });
    },
    dropped(reason) {
      syncStore.setState({ connection: "dropped", detail: reason });
    },
    protocolError(message) {
      // A push this window could not read means it may have missed a change, so
      // it stops claiming to be in sync rather than carrying on quietly.
      documentStore.getState().noteOutOfSync(message);
    },
  },
});

let started = false;

/** Start the session. Idempotent, because React may mount twice in dev. */
export function startSession(): void {
  if (started) return;
  started = true;
  projectSocket.connect();
}
