import { hashContent } from "@chord-garden/engine/live";
import type { DocKind } from "@chord-garden/format/pure";

/**
 * The HTTP surface, shared by the server and the browser so the two cannot
 * drift. Deliberately node-free: the app and harness bundles import these types,
 * and `server.ts` cannot be reached from a browser.
 *
 * The shape is the sidecar's `openProject`/`readAsset`/`writeFile` (PLAN.md §11)
 * minus the watcher and the change-push WebSocket, so Phase 4 adds to this
 * rather than reshaping what already exists.
 */
export interface ApiDiagnostic {
  severity: string;
  code: string;
  file: string;
  message: string;
}

export interface ProjectSummary {
  name: string;
  root: string;
  /** True when the project loaded, validated, and can be played. */
  ok: boolean;
  /** Every document of the bundle, sorted by path, with its resolved kind. */
  files: { path: string; kind: DocKind }[];
  diagnostics: ApiDiagnostic[];
}

export interface ProjectList {
  projects: { name: string; root: string }[];
}

/**
 * Every document of a project, with its bytes, from one `loadProject` (PLAN.md
 * §12).
 *
 * This exists because fetching the documents one at a time is not atomic with
 * respect to the watcher: an agent editing during the load hands the browser a
 * mixture of two disk states — a model no validation ever passed — and the
 * mixture is only *detected* later, by the inventory check on the next push. One
 * read of the disk, one response, and the torn state is unreachable rather than
 * caught. It also turns N+1 round trips into one.
 */
export interface ProjectSnapshot {
  name: string;
  root: string;
  /** True when the project loaded, validated, and can be played. */
  ok: boolean;
  /** Every document, sorted by path, with the exact bytes that were validated. */
  files: SnapshotDocument[];
  diagnostics: ApiDiagnostic[];
}

/** One document of a write batch: canonical bytes for a project-relative path. */
export interface WriteRequestFile {
  path: string;
  contents: string;
  /**
   * Content hash of the bytes the caller believes are on disk right now, or
   * `null` for "I believe this file does not exist yet".
   *
   * Required, not optional. There is no watcher until Phase 4, so a UI that has
   * been open while an agent edited a file is holding a stale model and its next
   * write would silently overwrite that edit — which is precisely the failure
   * PLAN.md §3 cannot tolerate, since the two editors are supposed to be equals.
   * Making the precondition unskippable means an unconditional write is not
   * expressible, so no caller can forget it and lose someone else's work.
   */
  expectedHash: string | null;
}

/**
 * One document of a write batch to remove from disk.
 *
 * Deletion exists because some documents are legitimately *optional* and the
 * format will not let them be empty: `automation/<track>.json` requires at least
 * one lane, so removing a track's last automation lane has nowhere to land
 * except removing the file. Without this the UI would have to refuse that edit
 * and tell the human to go and delete a file by hand — a UI that cannot undo
 * what it can do.
 */
export interface WriteDeleteFile {
  path: string;
  /**
   * Content hash of the bytes the caller believes it is removing. Not nullable,
   * unlike a write's: "delete a file I believe does not exist" is not an
   * intention, it is a lost update waiting to happen. A caller that finds the
   * file already gone gets the same 409 as any other stale precondition.
   */
  expectedHash: string;
}

/**
 * A write batch. Batched because one UI edit can touch several files and the
 * project should not be observed half-updated (PLAN.md §12).
 *
 * `deletes` land in the same batch as `files`, and every precondition in the
 * batch is checked before anything is touched, so an edit that rewrites one
 * document and removes another cannot half-apply.
 */
export interface WriteRequest {
  files: WriteRequestFile[];
  /** Absent and empty mean the same thing: this batch removes nothing. */
  deletes?: WriteDeleteFile[];
}

/**
 * What the server persisted, per file. `contentHash` is the Phase 4 echo key,
 * and the value the caller should present as `expectedHash` next time.
 */
export interface WriteAck {
  path: string;
  bytes: number;
  contentHash: string;
}

/** HTTP status a write batch gets when the disk has moved under the caller. */
export const WRITE_CONFLICT_STATUS = 409;

export interface WriteResponse {
  ok: true;
  written: WriteAck[];
  /** Paths the batch removed, in the order they were removed. */
  removed: string[];
  /** The project re-validated after the batch landed, so the UI can show errors. */
  summary: ProjectSummary;
}

/**
 * Header carrying the session token (PLAN.md §10). A header rather than a query
 * parameter, so the token stays out of URLs, server logs, and the Referer.
 */
export const TOKEN_HEADER = "x-chord-garden-token";

/**
 * Header carrying the read-write session id from `WelcomeMessage.session`.
 *
 * A header rather than a field of the write body, because the snapshot read wants
 * it too: a snapshot served to the session holder is a snapshot that page has now
 * seen, which is what lets the sidecar establish those bytes and not re-announce
 * them.
 */
export const SESSION_HEADER = "x-chord-garden-session";

/** HTTP status for a write from something that does not hold the session. */
export const WRITE_SESSION_STATUS = 403;

/** Path, under a project mount, that upgrades to the sync WebSocket. */
export const SOCKET_PATH = "socket";

/** Path, under a project mount, serving every document in one response. */
export const SNAPSHOT_PATH = "snapshot";

/**
 * Version of the sync protocol below. Bumped when a message shape changes, and
 * checked in the handshake: a page left open across a rebuild is told to reload
 * rather than left silently misreading a message it half understands.
 */
export const SYNC_PROTOCOL = 3;

/** Largest client→server message the socket will read (PLAN.md §10). */
export const MAX_SOCKET_MESSAGE_BYTES = 64 * 1024;

/**
 * How long a socket may stay silent after connecting before it must have
 * authenticated. An unauthenticated socket costs a file descriptor and can do
 * nothing, so it is not allowed to sit there.
 */
export const HELLO_TIMEOUT_MS = 10_000;

/**
 * The client's first and only pre-authentication message (PLAN.md §10: prefer
 * first-message authentication over a token in the URL query string).
 */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  token: string;
  project: string;
  /**
   * `inventoryHash` of what this page already holds, when it holds anything.
   *
   * Present only on a reconnect: a page with a project in memory is telling the
   * sidecar which disk state it is caught up to, and asking to be sent a full
   * snapshot if that is no longer the disk. Absent on a first connection, where
   * the page has nothing and loads over HTTP instead.
   */
  inventory?: string;
  /**
   * The sample content this page holds, when it holds any.
   *
   * The document `inventory` cannot cover it: samples are fetched separately and
   * lazily — a page that has never played holds none of them — so folding them into
   * that one hash would make every reconnect look like a page behind the disk. It is
   * per-path rather than a single hash for the same reason the push is: what the page
   * needs back is *which* files to fetch again.
   *
   * Absent means "none, or this page does not play audio". A page that holds nothing
   * needs no announcement, because the bytes it eventually fetches will be whatever
   * is on disk then.
   */
  samples?: readonly SampleFile[];
}

export type ClientMessage = HelloMessage;

/** A sample file and the content hash of its bytes. */
export interface SampleFile {
  /** Project-relative, always under `samples/` (docs/format-spec.md §8). */
  path: string;
  contentHash: string;
}

/** One document in a pushed snapshot, named and hashed but without its bytes. */
export interface SnapshotFile {
  path: string;
  kind: DocKind;
  contentHash: string;
}

/** A document with the exact bytes the sidecar read and validated. */
export interface SnapshotDocument extends SnapshotFile {
  text: string;
}

/**
 * A hash over a project's document inventory: which paths exist and what is in
 * them, and nothing else.
 *
 * One value that answers "are these two views of the project the same?" — used by
 * a reconnecting page to tell the sidecar what it holds, so the sidecar can push
 * a full snapshot only when the disk has actually moved. Sorted internally, so
 * the two sides cannot disagree by iterating in different orders, and defined
 * here beside the messages that carry it so there is one definition of it.
 */
export function inventoryHash(files: Iterable<{ path: string; contentHash: string }>): string {
  // NUL separates the two fields because it is the one byte a path cannot contain,
  // so no path and hash can ever be mistaken for a different pair. Written as an
  // escape: a literal NUL in a source file is invisible in every editor and makes
  // git treat the file as binary.
  const lines = [...files]
    .map((file) => `${file.path}\u0000${file.contentHash}`)
    .sort()
    .join("\n");
  return hashContent(new TextEncoder().encode(lines));
}

/**
 * An external edit that the sidecar read, validated as a whole project, and is
 * handing to the browser (PLAN.md §12 step 4).
 *
 * PLAN.md §11 sketches per-file `fileChanged`/`fileRemoved`/`diagnosticsChanged`
 * pushes. This is deliberately one message instead: an agent's edit routinely
 * touches several files, per-file messages cannot say "these landed together and
 * the result validates", and §12 requires the browser to accept a snapshot only
 * after project-level validation passes. So the unit of push is the snapshot,
 * with the changed files named inside it.
 */
export interface ProjectChangedMessage {
  type: "projectChanged";
  /**
   * How much of the disk `changed` carries.
   *
   * `diff` is the ordinary push: only documents whose bytes differ from what the
   * sidecar last established, so `removed` is the only statement about deletions
   * and a file the browser holds that the inventory does not name is a
   * desynchronised browser.
   *
   * `full` carries *every* document's bytes, and is sent when a reconnecting page
   * says it holds a different inventory than the sidecar has established (PLAN.md
   * §12: changes made while a socket was down were announced to nobody). The
   * inventory is then authoritative about deletions too — the sidecar cannot know
   * which removals that page already saw — so the browser must treat a document
   * it holds and the inventory does not name as removed. Stated rather than
   * inferred from an empty `removed`, because the two cases need opposite
   * responses and guessing between them either loses a file or reports a false
   * desync.
   */
  scope: "diff" | "full";
  /**
   * Every document on disk after the change, so the browser can prove its own
   * copy is complete rather than assume it. A path the browser cannot account
   * for is a desynchronised browser, which it must say out loud.
   */
  files: SnapshotFile[];
  /** Documents whose bytes differ from what the sidecar last established. */
  changed: SnapshotDocument[];
  /** Documents that were part of the last snapshot and are gone. */
  removed: string[];
  /** Warnings from the validated snapshot; errors would make it unsendable. */
  diagnostics: ApiDiagnostic[];
}

/**
 * Sample files on disk are no longer the ones this page is playing (PLAN.md §14).
 *
 * Its own message, and not part of `ProjectChangedMessage`, because replacing
 * `samples/kick.wav` changes no document: there is nothing to reconcile into the
 * model, no bytes for a write precondition, and nothing for the reconcile's
 * inventory checks to be consistent with. Smuggling it into a document snapshot
 * would mean inventing a document change that did not happen. The two do arrive
 * together — an agent adding a kit voice and dropping in the WAV it names — and
 * then they are two messages from one settle window, this one first, because the
 * worklet refuses a graph naming content it has not been sent.
 *
 * The audio itself does not travel here. Samples are fetched from the confined
 * `files/` endpoint, which serves them `no-store`; a message carrying megabytes of
 * WAV would also have to grow a chunking protocol for no benefit.
 */
export interface SamplesChangedMessage {
  type: "samplesChanged";
  /**
   * Every sample the project references, with the hash of the bytes on disk.
   *
   * This is the authority, and the page acts on it by comparing it with the content
   * it holds — so a redundant announcement is a no-op rather than a re-fetch, and a
   * page whose own state has moved past this message is not dragged backwards. There
   * is no `scope` here for the same reason: a page holds only the samples its
   * schedule needs, a subset, so a path it does not hold means nothing at all rather
   * than needing two readings the way an absent *document* does.
   */
  samples: SampleFile[];
  /**
   * The paths whose content differs from what the sidecar last established — what it
   * noticed, for a log or a UI line. Advisory: the page decides what to fetch from
   * `samples`, so an over- or under-stated `changed` cannot make it hold the wrong
   * audio.
   */
  changed: string[];
}

/**
 * The project on disk does not currently validate, so there is no snapshot to
 * adopt. Sent rather than swallowed: a half-finished multi-file agent edit is
 * expected and transient, but the browser still has to show why it has stopped
 * following the disk, and its write preconditions are now deliberately stale.
 */
export interface ProjectInvalidMessage {
  type: "projectInvalid";
  diagnostics: ApiDiagnostic[];
}

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  project: string;
  /**
   * This session's write credential (PLAN.md §12, single-writer).
   *
   * The sidecar admits one read-write session per project, and this is the name of
   * it: a write must present it in the `x-chord-garden-session` header, so a
   * window that was *refused* the session cannot write at all. Minted per admitted
   * socket, so it also changes across a reconnect and a stale one is refused
   * rather than silently honoured. Not a secret — the token is what keeps other
   * origins out; this is what keeps the second window out.
   */
  session: string;
}

/**
 * The handshake was refused. Carries a human-readable reason because every case
 * — wrong token, wrong protocol, project already open elsewhere — is something
 * the person looking at the page has to be told (PLAN.md §12 single-writer).
 */
export interface RejectedMessage {
  type: "rejected";
  reason: string;
}

/** A protocol violation. The socket is closed immediately afterwards. */
export interface SocketErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | RejectedMessage
  | SocketErrorMessage
  | ProjectChangedMessage
  | ProjectInvalidMessage
  | SamplesChangedMessage;

/** Close code for "this project is already open in another window". */
export const CLOSE_ALREADY_OPEN = 4001;
/** Close code for a refused handshake that is not a single-writer rejection. */
export const CLOSE_UNAUTHORIZED = 4003;

/** Global the served HTML defines so a page's own scripts can authenticate. */
export const TOKEN_GLOBAL = "__CHORD_GARDEN_TOKEN__";
