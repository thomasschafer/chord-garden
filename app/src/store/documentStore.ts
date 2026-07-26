import {
  canonicalFiles,
  parseSteps,
  ticksPerBar,
  type GridPatternDoc,
  type Project,
} from "@chord-garden/format/pure";
import { hashContent } from "@chord-garden/engine/live";
import { createStore, type StoreApi } from "zustand/vanilla";

/** Debounce window for writes (PLAN.md §12 step 1). */
export const WRITE_DEBOUNCE_MS = 250;

/** One canonical document, ready to persist. */
export interface PendingFile {
  path: string;
  contents: string;
  /**
   * Hash of the bytes this editor believes are currently on disk, or `null` for
   * "no such file yet". The server refuses the batch if reality disagrees, which
   * is what keeps an editor that has been open across an agent's edit from
   * overwriting it.
   */
  expectedHash: string | null;
}

/**
 * Content hash of a document's text, over UTF-8 bytes.
 *
 * The engine's hash, not a second one: the server hashes the file on disk with
 * exactly this function, and two implementations of "the hash of these bytes"
 * would be a precondition that fails for no reason.
 */
export function hashText(text: string): string {
  return hashContent(new TextEncoder().encode(text));
}

/**
 * A write was refused because the disk moved underneath. Thrown by the sink;
 * the store stops writing rather than retrying, because a retry is an overwrite.
 */
export class WriteConflictError extends Error {
  readonly paths: readonly string[];

  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = "WriteConflictError";
    this.paths = paths;
  }
}

/** A validation message about the project, from whoever last looked at it. */
export interface DocumentDiagnostic {
  severity: string;
  code: string;
  file: string;
  message: string;
}

export interface WriteOutcome {
  /** The project's diagnostics after the batch landed, so errors surface at once. */
  diagnostics: readonly DocumentDiagnostic[];
}

/**
 * Where writes go. An interface rather than the HTTP client so the store can be
 * exercised against a real server, a counting double, or a failing double
 * without any of them having to pretend to be a browser.
 */
export interface DocumentSink {
  write(files: readonly PendingFile[]): Promise<WriteOutcome>;
}

/** What the store was opened with: the model, and the bytes it came from. */
export interface OpenedProject {
  project: Project;
  /** Project-relative path to the exact text the server served for it. */
  texts: ReadonlyMap<string, string>;
  diagnostics?: readonly DocumentDiagnostic[];
}

export interface DocumentState {
  /**
   * The canonical in-memory model, and the single source both the UI and the
   * audio engine read (PLAN.md §10). Replaced wholesale on every edit rather
   * than mutated, so a scheduler holding a reference keeps a stable snapshot
   * (PLAN.md §12 step 6).
   */
  project: Project | undefined;
  /** Canonical bytes for the current model, by project-relative path. */
  canonical: ReadonlyMap<string, string>;
  /** Canonical bytes as last agreed with the server. The dirty baseline. */
  persisted: ReadonlyMap<string, string>;
  /**
   * The bytes this editor believes are on disk, which is not the same map as
   * `persisted`. A file that was valid but non-canonical when opened has a
   * canonical baseline (so it is not reported dirty) and different disk bytes
   * (so its write precondition still matches reality).
   */
  onDisk: ReadonlyMap<string, string>;
  /** Paths whose canonical bytes differ from `persisted`, sorted. */
  dirty: readonly string[];
  /** Paths in the write batch currently in flight. */
  writing: readonly string[];
  /**
   * Files that were already on disk in non-canonical form when the project was
   * opened. Not an error and not rewritten: the UI only writes what it edits, so
   * an untouched file keeps its bytes until `musictool fmt` or an edit reaches it.
   */
  unformatted: readonly string[];
  /** Bumped on every applied edit; a cheap identity for a model snapshot. */
  revision: number;
  /** Completed write batches this session. */
  batchesWritten: number;
  lastWriteError: string | undefined;
  /**
   * Set when the server refused a write because a file changed underneath. While
   * it is set the store writes nothing: the edits are still here and still
   * dirty, but sending them again would overwrite whoever else edited the file.
   * Only `open` clears it — which is the reload the UI asks the human for.
   */
  conflict: { paths: readonly string[]; message: string } | undefined;
  /** Project diagnostics, refreshed by the server after every write. */
  diagnostics: readonly DocumentDiagnostic[];

  open(loaded: OpenedProject): void;
  setProjectName(name: string): void;
  setTempoBpmX100(bpm: number): void;
  setPatternLaneSteps(patternId: string, lane: string, steps: string): void;
  /** Write every dirty file now, cancelling any pending debounce. */
  flushNow(): Promise<void>;
}

export type DocumentStore = StoreApi<DocumentState>;

export interface DocumentStoreOptions {
  sink: DocumentSink;
  debounceMs?: number;
}

/**
 * The document store.
 *
 * Two decisions are worth stating, because everything else follows from them.
 *
 * **The store has no serializer.** Every byte it can ever write comes from
 * `canonicalFiles`, the function `musictool fmt` calls. PLAN.md §3 makes the UI
 * one editor among two, and the moment the UI can emit bytes the CLI would not,
 * a UI edit and an agent edit stop being interchangeable — the same class of
 * divergence Phase 2 spent its effort eliminating between live and offline audio.
 * `test/byteIdentity.test.ts` is the standing proof.
 *
 * **Dirty tracking is derived, not declared.** After each edit the store
 * re-serializes the whole project and compares it against the bytes the server
 * last agreed to; the files that differ are the files that get written. The
 * alternative — each action naming the files it touches — is one forgotten
 * `markDirty` away from a lost edit, and gets the cross-file cases wrong
 * (renaming a track touches its own file, the arrangement, and `trackOrder`).
 * Deriving it costs a re-serialization of a small bundle per keystroke and
 * cannot drift. If a project ever grows large enough for that to matter, the fix
 * is to hash per file, not to go back to bookkeeping.
 */
export function createDocumentStore(options: DocumentStoreOptions): DocumentStore {
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const store = createStore<DocumentState>((set, get) => {
    /**
     * Replace the model with an edited clone and recompute what must be written.
     *
     * The clone comes first and the serialization second, so an edit that
     * produces an unserializable document (an invalid `steps` string, a float
     * where the format demands an integer) throws before anything is committed
     * and leaves the store on its last good state.
     */
    function applyEdit(mutate: (draft: Project) => void): void {
      const current = get().project;
      if (current === undefined) throw new Error("cannot edit: no project is open");
      const draft = structuredClone(current);
      mutate(draft);
      const canonical = canonicalFiles(draft);
      const { dirty, removed } = diffAgainst(get().persisted, canonical);
      if (removed.length > 0) {
        // No edit in this stage can delete a document, and the write endpoint
        // cannot express a deletion, so this is a bug rather than a state to
        // paper over.
        throw new Error(`edit would remove ${removed.join(", ")}, which the write path cannot express`);
      }
      set({ project: draft, canonical, dirty, revision: get().revision + 1 });
      scheduleFlush();
    }

    function scheduleFlush(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, debounceMs);
    }

    /**
     * Persist the dirty files. Serialized against itself: a second call while a
     * batch is in flight waits for it and then writes whatever is still dirty,
     * so edits made mid-write are never dropped and two batches never race for
     * the same file.
     */
    function flush(): Promise<void> {
      if (inFlight !== undefined) {
        return inFlight.then(() => (get().dirty.length > 0 ? flush() : undefined));
      }
      // A conflict is not a transient failure, so it is not retried. The edits
      // stay in the model and stay dirty; nothing more goes to disk until the
      // human reloads and decides what to do.
      if (get().conflict !== undefined) return Promise.resolve();
      const dirty = get().dirty;
      if (dirty.length === 0) return Promise.resolve();
      const canonical = get().canonical;
      const onDisk = get().onDisk;
      const files = dirty.map((path) => {
        const contents = canonical.get(path);
        if (contents === undefined) throw new Error(`internal error: "${path}" is dirty but has no canonical bytes`);
        const believed = onDisk.get(path);
        return { path, contents, expectedHash: believed === undefined ? null : hashText(believed) };
      });

      set({ writing: dirty, lastWriteError: undefined });
      const run = options.sink
        .write(files)
        .then((outcome) => {
          // The bytes we sent become the new baseline, and the new belief about
          // disk. Dirtiness is recomputed against the *current* model, which may
          // have moved on while the request was open — that is what keeps a
          // mid-write edit alive.
          const persisted = new Map(get().persisted);
          const written = new Map(get().onDisk);
          for (const file of files) {
            persisted.set(file.path, file.contents);
            written.set(file.path, file.contents);
          }
          const { dirty: stillDirty } = diffAgainst(persisted, get().canonical);
          set({
            persisted,
            onDisk: written,
            dirty: stillDirty,
            writing: [],
            unformatted: unformattedIn(written, persisted),
            batchesWritten: get().batchesWritten + 1,
            diagnostics: outcome.diagnostics,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof WriteConflictError) {
            set({ writing: [], conflict: { paths: error.paths, message: error.message } });
            return;
          }
          // An ordinary failure leaves the files dirty, so the next flush retries.
          set({ writing: [], lastWriteError: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          inFlight = undefined;
        });
      inFlight = run;
      return run;
    }

    return {
      project: undefined,
      canonical: new Map(),
      persisted: new Map(),
      onDisk: new Map(),
      dirty: [],
      writing: [],
      unformatted: [],
      revision: 0,
      batchesWritten: 0,
      lastWriteError: undefined,
      conflict: undefined,
      diagnostics: [],

      open(loaded) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        const canonical = canonicalFiles(loaded.project);
        // The baseline is the canonical form of what was loaded, not the bytes
        // on disk. A file that was already non-canonical stays untouched until
        // an edit reaches it; anything else would make opening the app rewrite
        // files the user never edited. The disk bytes are kept separately,
        // because they are what the write precondition has to match.
        const onDisk = new Map(loaded.texts);
        set({
          project: loaded.project,
          canonical,
          persisted: new Map(canonical),
          onDisk,
          dirty: [],
          writing: [],
          unformatted: unformattedIn(onDisk, canonical),
          revision: get().revision + 1,
          lastWriteError: undefined,
          conflict: undefined,
          diagnostics: loaded.diagnostics ?? [],
        });
      },

      setProjectName(name) {
        applyEdit((draft) => {
          draft.project.name = name;
        });
      },

      setTempoBpmX100(bpm) {
        if (!Number.isInteger(bpm)) {
          throw new Error(`tempo must be an integer in bpm×100, got ${bpm}`);
        }
        applyEdit((draft) => {
          const first = draft.project.tempoMap[0];
          if (first === undefined) throw new Error("cannot set tempo: the project has an empty tempoMap");
          first.bpm = bpm;
        });
      },

      setPatternLaneSteps(patternId, lane, steps) {
        applyEdit((draft) => {
          const pattern = draft.patterns.get(patternId);
          if (pattern === undefined) throw new Error(`cannot edit steps: no pattern "${patternId}"`);
          if (pattern.kind !== "grid") throw new Error(`cannot edit steps: pattern "${patternId}" is not a grid`);
          const target = (pattern as GridPatternDoc).lanes.find((entry) => entry.lane === lane);
          if (target === undefined) throw new Error(`cannot edit steps: pattern "${patternId}" has no lane "${lane}"`);
          const bars = pattern.lengthTicks / ticksPerBar(draft.project.ppqn, draft.project.meterMap[0]!.timeSignature);
          const parsed = parseSteps(steps, {
            file: `patterns/${patternId}.json`,
            pointer: "",
            stepsPerBar: target.grid.stepsPerBar,
            bars,
          });
          if (parsed.hits === undefined) {
            throw new Error(
              `cannot edit steps: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
            );
          }
          target.steps = steps;
        });
      },

      async flushNow() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        await flush();
      },
    };
  });

  return store;
}

/** Documents whose bytes on disk are valid but not the canonical form. */
function unformattedIn(onDisk: ReadonlyMap<string, string>, canonical: ReadonlyMap<string, string>): string[] {
  return [...canonical.keys()].filter((path) => onDisk.get(path) !== canonical.get(path)).sort();
}

/** Paths whose bytes changed, and paths that vanished, against a baseline. */
function diffAgainst(
  baseline: ReadonlyMap<string, string>,
  canonical: ReadonlyMap<string, string>,
): { dirty: string[]; removed: string[] } {
  const dirty: string[] = [];
  for (const [path, contents] of canonical) {
    if (baseline.get(path) !== contents) dirty.push(path);
  }
  const removed = [...baseline.keys()].filter((path) => !canonical.has(path));
  return { dirty: dirty.sort(), removed: removed.sort() };
}
