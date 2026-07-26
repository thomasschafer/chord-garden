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
 * A write batch. Batched because one UI edit can touch several files and the
 * project should not be observed half-updated (PLAN.md §12).
 */
export interface WriteRequest {
  files: WriteRequestFile[];
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
  /** The project re-validated after the batch landed, so the UI can show errors. */
  summary: ProjectSummary;
}

/**
 * Header carrying the session token (PLAN.md §10). A header rather than a query
 * parameter, so the token stays out of URLs, server logs, and the Referer.
 */
export const TOKEN_HEADER = "x-chord-garden-token";

/** Path, under a project mount, that upgrades to the sync WebSocket. */
export const SOCKET_PATH = "socket";

/**
 * Version of the sync protocol below. Bumped when a message shape changes, and
 * checked in the handshake: a page left open across a rebuild is told to reload
 * rather than left silently misreading a message it half understands.
 */
export const SYNC_PROTOCOL = 1;

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
}

export type ClientMessage = HelloMessage;

/** One document in a pushed snapshot, with the bytes the server validated. */
export interface SnapshotFile {
  path: string;
  kind: DocKind;
  contentHash: string;
}

export interface ChangedFile extends SnapshotFile {
  /** Exactly the bytes the sidecar read and validated. */
  text: string;
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
   * Every document on disk after the change, so the browser can prove its own
   * copy is complete rather than assume it. A path the browser cannot account
   * for is a desynchronised browser, which it must say out loud.
   */
  files: SnapshotFile[];
  /** Documents whose bytes differ from what the sidecar last established. */
  changed: ChangedFile[];
  /** Documents that were part of the last snapshot and are gone. */
  removed: string[];
  /** Warnings from the validated snapshot; errors would make it unsendable. */
  diagnostics: ApiDiagnostic[];
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
  | ProjectInvalidMessage;

/** Close code for "this project is already open in another window". */
export const CLOSE_ALREADY_OPEN = 4001;
/** Close code for a refused handshake that is not a single-writer rejection. */
export const CLOSE_UNAUTHORIZED = 4003;

/** Global the served HTML defines so a page's own scripts can authenticate. */
export const TOKEN_GLOBAL = "__CHORD_GARDEN_TOKEN__";
