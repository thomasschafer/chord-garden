import type { DocKind } from "@chord-garden/format/pure";

/**
 * The read-only HTTP surface, shared by the server and the browser so the two
 * cannot drift. Deliberately node-free: the harness bundle imports these types,
 * and `server.ts` cannot be reached from a browser.
 *
 * The shape is the sidecar's `openProject`/`readAsset` (PLAN.md §11) minus
 * everything that writes, so Phase 4 can add `writeFile` and the change-push
 * WebSocket alongside rather than reshaping what already exists.
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
