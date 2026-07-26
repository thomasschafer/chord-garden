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

/** Global the served HTML defines so a page's own scripts can authenticate. */
export const TOKEN_GLOBAL = "__CHORD_GARDEN_TOKEN__";
