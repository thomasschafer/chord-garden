import { inventoryHash } from "@chord-garden/dev-server/api";
import { ProjectClient, WriteConflict } from "@chord-garden/dev-server/client";
import { ProjectSocket, type SyncTransportFactory } from "@chord-garden/dev-server/socket";
import { connectAudioToDocument } from "./audio/documentBridge";
import { LivePlayer } from "./audio/livePlayer";
import {
  createDocumentStore,
  hashText,
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
  async write(files, deletes) {
    if (projectSocket.session === undefined) {
      // The sidecar only accepts writes from the window holding its read-write
      // session, and this window does not hold one right now. Failing here rather
      // than sending a write that will be refused keeps the reason accurate: the
      // edits stay dirty and go out when the connection is back.
      throw new Error(
        "this window is not connected to the sidecar, so it cannot write; the edits are kept and will be written when the connection returns",
      );
    }
    try {
      const response = await client.write(projectName, files, deletes);
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
  /**
   * How this window recovers from a sidecar restart (PLAN.md §10: the token is
   * minted per run).
   *
   * Without it, restarting the sidecar under an open page refuses that page for
   * good — and because the refusal replaces the whole UI, every edit it had not yet
   * written goes with it, moments after the page promised they would be "written
   * when the connection returns". Routed through the client rather than fetched here
   * so that the socket and the HTTP requests adopt the same token together; a page
   * that re-handshaked while `ProjectClient` kept the old one would reconnect and
   * then fail every write.
   */
  refreshToken: () => client.refreshToken(),
  /**
   * What this window holds, hashed, so a reconnect can be replayed (PLAN.md §12).
   *
   * Built from the bytes this window believes are *on disk*, not from its canonical
   * model, because that is what the sidecar hashes: unsaved local edits are this
   * window's business and must not read as a disk state nobody else has.
   */
  inventory: () => {
    const onDisk = documentStore.getState().onDisk;
    if (onDisk.size === 0) return undefined;
    return inventoryHash([...onDisk].map(([path, text]) => ({ path, contentHash: hashText(text) })));
  },
  /**
   * The sample content this window is playing, so a reconnect can be told about a
   * file replaced while the socket was down.
   *
   * Not derivable from `inventory`: samples are not documents, and a page can hold a
   * document state exactly in step with the disk while its audio is a version behind
   * — which is the one case sample watching exists for, and the one a reconnect would
   * otherwise walk straight past.
   */
  samples: () => livePlayer.sampleContent(),
  handlers: {
    ready(reconnected) {
      syncStore.setState({ connection: "live", detail: undefined });
      const dirty = documentStore.getState().dirty.length > 0;
      if (reconnected && dirty) {
        // Reloading would throw the unsaved edits away, and it is not needed: the
        // hello told the sidecar which disk state this window holds, so anything
        // that changed while the socket was down arrives as a full snapshot and
        // reconciles under PLAN.md §12's last-writer-wins. What is owed is the other
        // direction — the edits that could not be written while there was no
        // session — so they go out now.
        void documentStore.getState().flushNow();
        return;
      }
      loadProjectIntoStore().catch((error: unknown) => {
        syncStore.setState({ loadError: error instanceof Error ? error.message : String(error) });
      });
    },
    changed(message) {
      documentStore.getState().applyExternalChange(message);
    },
    samplesChanged(message) {
      // Straight to the audio engine, never through the document store: no document
      // changed, so there is nothing here to reconcile, mark dirty or write back. The
      // engine compares the announced content hashes against what it holds and fetches
      // only what really moved.
      void livePlayer.applySampleChange(message.samples);
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

// The client learns the write session id from the socket, read fresh on every
// request: a reconnect mints a new one, and the sidecar refuses a stale one.
client.useSession(() => projectSocket.session);

let started = false;

/** Start the session. Idempotent, because React may mount twice in dev. */
export function startSession(): void {
  if (started) return;
  started = true;
  projectSocket.connect();
}
