import {
  canonicalFiles,
  formatSteps,
  HIGHEST_MIDI,
  LOWEST_MIDI,
  parseSteps,
  pitchToMidi,
  ticksPerBar,
  type GridLane,
  type GridPatternDoc,
  type NoteEvent,
  type NotesPatternDoc,
  type Project,
  type StepEvent,
} from "@chord-garden/format/pure";
import { createStore, type StoreApi } from "zustand/vanilla";
import { hashText } from "./hash";
import { reconcileExternalChange, type ExternalChange } from "./reconcile";

export { hashText } from "./hash";
export type { ExternalChange } from "./reconcile";

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

/**
 * What an edit means to a running transport (PLAN.md §12 step 6).
 *
 * - `none` — nothing an engine can hear. A project's name.
 * - `parameters` — the same events, rendered differently: an instrument param or
 *   an automation point. Takes effect in the next scheduling window.
 * - `structural` — the events themselves moved, appeared or vanished. Queued to
 *   the next bar boundary while playing; immediate while stopped.
 *
 * **This is the seam.** PLAN.md §12 step 5 defers "compute semantic model-domain
 * patches" to Phase 4, and classifying an arbitrary before/after pair of documents
 * is that work. Nothing here does it: each action states its own effect, because
 * the action already knows what it changed and a lookup table beats a diff it
 * cannot yet compute. When the Phase 4 differ lands it replaces the literals in
 * `applyEdit` calls and nothing downstream of `audioEdit` changes.
 *
 * The line between `parameters` and `structural` is not a judgement call: the
 * engine's `LiveScheduler.updateParameters` re-checks it against the recompiled
 * schedule and throws if a caller claimed `parameters` for an edit that moved an
 * event. So a misclassification in this direction is loud, not silent. Note where
 * that puts velocity — it is carried by the compiled event, so editing it is
 * `structural` even though a musician would call it expression.
 */
export type AudioEffect = "none" | "parameters" | "structural";

/**
 * The most recent edit, for the audio layer. Carries its own project snapshot so
 * a consumer reacting to it cannot pick up a later edit's model by accident.
 */
export interface AudioEdit {
  revision: number;
  effect: AudioEffect;
  project: Project;
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
   *
   * With the Phase 4 watcher this is no longer a dead end. A 409 means the disk
   * moved, and the watcher is about to say how — so `applyExternalChange` clears
   * the conflict once it has re-established every file the conflict named, and
   * writing resumes on its own. It stays set only while the disagreement is
   * unexplained: a project that does not validate on disk, or a desynchronised
   * window, both of which need the human. `open` still clears it, which is the
   * reload the UI offers as the manual way out.
   */
  conflict: { paths: readonly string[]; message: string } | undefined;
  /** Project diagnostics, refreshed by the server after every write. */
  diagnostics: readonly DocumentDiagnostic[];
  /**
   * False while the project *on disk* does not validate, which is a normal,
   * transient state in the middle of a multi-file agent edit (PLAN.md §12). The
   * model in memory is the last valid one and stays playable; `diagnostics` says
   * what is wrong on disk. Nothing is adopted until it validates again.
   */
  diskValid: boolean;
  /**
   * Set when this window can no longer prove its copy matches the disk, which is
   * unrecoverable without a reload. Loud on purpose: the alternative to saying so
   * is adopting a model that was never validated as a whole.
   */
  outOfSync: string | undefined;
  /**
   * The last external edit this window accepted, for UI that has to react to it —
   * clearing a selection whose meaning has moved, above all. `discarded` names
   * files whose unsaved local edits the external version replaced (PLAN.md §12's
   * last-writer-wins warning), and is retained until the next external edit.
   */
  lastExternalEdit:
    | { revision: number; adopted: readonly string[]; removed: readonly string[]; discarded: readonly string[] }
    | undefined;
  /** External snapshots accepted this session. */
  externalEditsAccepted: number;
  /**
   * The last edit and what it means to a running transport. `undefined` until the
   * first edit of a session, and reset by `open`.
   */
  audioEdit: AudioEdit | undefined;

  open(loaded: OpenedProject): void;
  setProjectName(name: string): void;
  setTempoBpmX100(bpm: number): void;
  setPatternLaneSteps(patternId: string, lane: string, steps: string): void;
  /**
   * Turn one grid step of one lane on or off.
   *
   * The step index is the unit the grammar defines — zero-based across the whole
   * pattern — and never a character offset into `steps`, where a space or a `|`
   * would make it mean a different step (docs/format-spec.md §5). The string is
   * re-derived from the parsed hit set by `formatSteps`, so the UI cannot invent a
   * spacing `fmt` disagrees with.
   *
   * `stepsPerBar` is only consulted when the lane does not exist yet, in which
   * case it is created empty; an existing lane keeps its own grid.
   */
  toggleGridStep(patternId: string, lane: string, step: number, stepsPerBar: number): void;
  /**
   * Set, change or clear the per-step expression overrides of one hit. A field
   * given as `undefined` is removed, and an entry left with nothing but its
   * `step` is dropped, because `fmt` does not emit empty overrides.
   */
  setStepEvent(patternId: string, lane: string, step: number, patch: StepEventPatch): void;
  /** Append a note. Its array position is a handle for this session only. */
  addNote(patternId: string, note: NoteEvent): void;
  /** Change one note in place, by its position in the in-memory `notes` array. */
  updateNote(patternId: string, index: number, changes: NotePatch): void;
  deleteNote(patternId: string, index: number): void;
  /** Write every dirty file now, cancelling any pending debounce. */
  flushNow(): Promise<void>;

  /**
   * Fold an external edit — an agent's, or a hand edit — into the model
   * (PLAN.md §12 step 4). Only ever called with a snapshot the sidecar has
   * already validated as a whole project.
   */
  applyExternalChange(change: ExternalChange): void;
  /**
   * Note that the project on disk does not currently validate. The model is left
   * exactly as it is; the diagnostics are shown.
   */
  noteDiskInvalid(diagnostics: readonly DocumentDiagnostic[]): void;
  /** Note that this window can no longer trust its copy. Needs a reload. */
  noteOutOfSync(message: string): void;
}

/**
 * Step overrides to apply. Present-and-`undefined` means "remove this field",
 * absent means "leave it alone" — which is why `exactOptionalPropertyTypes` is on
 * and the type says so explicitly.
 */
export type StepEventPatch = {
  [K in keyof Omit<StepEvent, "step">]?: number | undefined;
};

/** Fields every note must have, which a patch may change but not remove. */
export const REQUIRED_NOTE_FIELDS = ["pitch", "startTick", "durationTicks", "velocity"] as const;
/** Fields a note may carry, which a patch may also remove by passing `undefined`. */
export const OPTIONAL_NOTE_FIELDS = ["microTicks", "probability", "ratchet"] as const;

export type RequiredNoteField = (typeof REQUIRED_NOTE_FIELDS)[number];
export type OptionalNoteField = (typeof OPTIONAL_NOTE_FIELDS)[number];

/**
 * Changes to one note.
 *
 * The asymmetry is the point, and it is in the type rather than only in a runtime
 * check: an optional field may be cleared by passing `undefined`, and a required one
 * may not, because a note without a pitch or a velocity is not a note. `updateNote`
 * still refuses it at run time — a JS caller can reach it — but a TypeScript caller
 * cannot express the mistake.
 */
export type NotePatch = { [K in RequiredNoteField]?: NoteEvent[K] } & {
  [K in OptionalNoteField]?: number | undefined;
};

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
    function applyEdit(effect: AudioEffect, mutate: (draft: Project) => void): void {
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
      const revision = get().revision + 1;
      set({ project: draft, canonical, dirty, revision, audioEdit: { revision, effect, project: draft } });
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

      // What this editor believed about disk when the batch left, per path. Only
      // an accepted external edit can change that while a batch is open, and an
      // external edit is *newer news about the disk* than the ack of a write that
      // was already in flight. So the ack is not allowed to overwrite it — see
      // the filter in the success handler.
      const believedAtSend = new Map(files.map((file) => [file.path, onDisk.get(file.path)]));

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
            if (written.get(file.path) !== believedAtSend.get(file.path)) {
              // An external edit to this file was adopted while the write was in
              // flight. Disk holds *its* bytes, not ours; recording ours here
              // would leave a precondition that is a lie and a "dirty" flag that
              // reads as an edit to re-send, which is how a lost agent edit turns
              // into an overwrite.
              continue;
            }
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
      diskValid: true,
      outOfSync: undefined,
      lastExternalEdit: undefined,
      externalEditsAccepted: 0,
      audioEdit: undefined,

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
          diskValid: true,
          outOfSync: undefined,
          lastExternalEdit: undefined,
          audioEdit: undefined,
        });
      },

      setProjectName(name) {
        applyEdit("none", (draft) => {
          draft.project.name = name;
        });
      },

      setTempoBpmX100(bpm) {
        if (!Number.isInteger(bpm)) {
          throw new Error(`tempo must be an integer in bpm×100, got ${bpm}`);
        }
        // Structural, not parametric: every event's sample position is derived
        // from the tempo, so the whole schedule moves.
        applyEdit("structural", (draft) => {
          const first = draft.project.tempoMap[0];
          if (first === undefined) throw new Error("cannot set tempo: the project has an empty tempoMap");
          first.bpm = bpm;
        });
      },

      setPatternLaneSteps(patternId, lane, steps) {
        applyEdit("structural", (draft) => {
          const { lane: target, bars } = gridLane(draft, patternId, lane);
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

      toggleGridStep(patternId, laneName, step, stepsPerBar) {
        applyEdit("structural", (draft) => {
          const pattern = gridPattern(draft, patternId);
          const bars = barsOf(draft, pattern.lengthTicks);
          let lane = pattern.lanes.find((entry) => entry.lane === laneName);
          if (lane === undefined) {
            assertVoiceExists(draft, patternId, laneName);
            assertStepGrid(draft, stepsPerBar);
            lane = { lane: laneName, grid: { stepsPerBar }, steps: formatSteps([], stepsPerBar, bars) };
            pattern.lanes.push(lane);
          }
          const hits = new Set(hitsOf(lane, patternId, bars));
          const total = lane.grid.stepsPerBar * bars;
          if (!Number.isInteger(step) || step < 0 || step >= total) {
            throw new Error(`cannot toggle step ${step} of lane "${laneName}": the lane has steps 0..${total - 1}`);
          }
          if (hits.has(step)) {
            hits.delete(step);
            // A `stepEvents` entry may only target a hit (`pattern.step-event-not-a-hit`),
            // so clearing the hit has to take its overrides with it. There is no
            // valid document in which they survive, which is why the UI marks a
            // step that carries them before it is clicked off.
            if (lane.stepEvents !== undefined) {
              lane.stepEvents = lane.stepEvents.filter((entry) => entry.step !== step);
              if (lane.stepEvents.length === 0) delete lane.stepEvents;
            }
          } else {
            hits.add(step);
          }
          lane.steps = formatSteps([...hits].sort((a, b) => a - b), lane.grid.stepsPerBar, bars);
        });
      },

      setStepEvent(patternId, laneName, step, patch) {
        applyEdit("structural", (draft) => {
          const { lane, bars } = gridLane(draft, patternId, laneName);
          if (!hitsOf(lane, patternId, bars).includes(step)) {
            throw new Error(
              `cannot set overrides on step ${step} of lane "${laneName}": that step is a rest, and a stepEvents entry must target a hit`,
            );
          }
          const existing = lane.stepEvents?.find((entry) => entry.step === step);
          const merged: StepEvent = { ...(existing ?? { step }) };
          for (const [field, value] of Object.entries(patch) as [keyof StepEventPatch, number | undefined][]) {
            if (value === undefined) {
              delete merged[field];
              continue;
            }
            checkStepEventField(field, value);
            merged[field] = value;
          }
          const rest = lane.stepEvents?.filter((entry) => entry.step !== step) ?? [];
          // One key left means one key that is only the step index, which `fmt`
          // would not write: the entry has stopped overriding anything.
          const next = Object.keys(merged).length > 1 ? [...rest, merged] : rest;
          if (next.length === 0) {
            delete lane.stepEvents;
          } else {
            lane.stepEvents = next.sort((a, b) => a.step - b.step);
          }
        });
      },

      addNote(patternId, note) {
        applyEdit("structural", (draft) => {
          const pattern = notesPattern(draft, patternId);
          checkNote(note, pattern);
          pattern.notes.push({ ...note });
        });
      },

      updateNote(patternId, index, changes) {
        applyEdit("structural", (draft) => {
          const pattern = notesPattern(draft, patternId);
          const existing = pattern.notes[index];
          if (existing === undefined) {
            throw new Error(`cannot update note ${index} of "${patternId}": the pattern has ${pattern.notes.length} notes`);
          }
          const next: NoteEvent = { ...existing };
          const required: readonly string[] = REQUIRED_NOTE_FIELDS;
          for (const [field, value] of Object.entries(changes) as [keyof NoteEvent, NoteEvent[keyof NoteEvent]][]) {
            if (value === undefined) {
              // `NotePatch` already forbids this to a typed caller; this is the
              // runtime half, for the callers types cannot reach.
              if (required.includes(field)) throw new Error(`cannot remove required note field "${field}"`);
              delete next[field];
              continue;
            }
            // Assigning through a union of value types needs one cast; the
            // per-field ranges are then checked by `checkNote` below.
            (next[field] as NoteEvent[keyof NoteEvent]) = value;
          }
          checkNote(next, pattern);
          pattern.notes[index] = next;
        });
      },

      deleteNote(patternId, index) {
        applyEdit("structural", (draft) => {
          const pattern = notesPattern(draft, patternId);
          if (pattern.notes[index] === undefined) {
            throw new Error(`cannot delete note ${index} of "${patternId}": the pattern has ${pattern.notes.length} notes`);
          }
          pattern.notes.splice(index, 1);
        });
      },

      async flushNow() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        await flush();
      },

      applyExternalChange(change) {
        const state = get();
        if (state.project === undefined) {
          // Nothing is open yet, so there is no model to fold this into. Not a
          // loss: every session loads the project over HTTP after connecting, and
          // that load reads the disk this change is already part of.
          return;
        }
        if (state.outOfSync !== undefined) return;

        const result = reconcileExternalChange({
          project: state.project,
          canonical: state.canonical,
          onDisk: state.onDisk,
          dirty: state.dirty,
          change,
        });
        if (result.kind === "noop") {
          // Bytes this editor already had. Still worth recording that the disk
          // validates, since a `projectInvalid` may have said otherwise, and its
          // diagnostics would otherwise stay on screen describing a disk state
          // that has since been fixed.
          set({ diskValid: true, diagnostics: [...change.diagnostics] });
          return;
        }
        if (result.kind === "outOfSync") {
          set({ outOfSync: result.message });
          return;
        }

        const canonical = canonicalFiles(result.project);
        const persisted = new Map(state.persisted);
        const onDisk = new Map(state.onDisk);
        for (const path of result.removed) {
          persisted.delete(path);
          onDisk.delete(path);
        }
        for (const [path, text] of result.adopted) {
          const bytes = canonical.get(path);
          if (bytes === undefined) {
            throw new Error(`internal error: adopted "${path}" has no canonical bytes`);
          }
          // The canonical form is the baseline, and the disk bytes are the belief
          // about disk — exactly as `open` does it. Setting the baseline to the
          // raw disk bytes instead would mark every non-canonical external edit
          // dirty, and the UI would write it straight back: the write/watch loop
          // PLAN.md §18 warns about, arriving through the front door.
          persisted.set(path, bytes);
          onDisk.set(path, text);
        }
        const { dirty } = diffAgainst(persisted, canonical);
        const revision = state.revision + 1;

        // The conflict was "the disk moved under us and we do not know how". Now
        // we know, for these files, so it stops applying to them.
        const conflict =
          state.conflict === undefined ||
          state.conflict.paths.every((path) => result.adopted.has(path) || result.removed.includes(path))
            ? undefined
            : state.conflict;

        set({
          project: result.project,
          canonical,
          persisted,
          onDisk,
          dirty,
          unformatted: unformattedIn(onDisk, canonical),
          revision,
          conflict,
          diskValid: true,
          outOfSync: undefined,
          diagnostics: [...change.diagnostics],
          externalEditsAccepted: state.externalEditsAccepted + 1,
          lastExternalEdit: {
            revision,
            adopted: [...result.adopted.keys()].sort(),
            removed: result.removed,
            discarded: result.discarded,
          },
          // Always structural: an external edit can have moved anything, and the
          // scheduler's own check (PLAN.md §12 step 6) would reject a softer
          // claim it could not substantiate.
          audioEdit: { revision, effect: "structural", project: result.project },
        });

        // A file the external edit took over may have been dirty, and now is not.
        // Anything still dirty is an edit to a file the agent did not touch, so it
        // is still owed a write.
        if (dirty.length > 0) scheduleFlush();
      },

      noteDiskInvalid(diagnostics) {
        set({ diskValid: false, diagnostics });
      },

      noteOutOfSync(message) {
        set({ outOfSync: message });
      },
    };
  });

  return store;
}

function gridPattern(draft: Project, patternId: string): GridPatternDoc {
  const pattern = draft.patterns.get(patternId);
  if (pattern === undefined) throw new Error(`no pattern "${patternId}"`);
  if (pattern.kind !== "grid") throw new Error(`pattern "${patternId}" is a ${pattern.kind} pattern, not a grid`);
  return pattern;
}

function notesPattern(draft: Project, patternId: string): NotesPatternDoc {
  const pattern = draft.patterns.get(patternId);
  if (pattern === undefined) throw new Error(`no pattern "${patternId}"`);
  if (pattern.kind !== "notes") throw new Error(`pattern "${patternId}" is a ${pattern.kind} pattern, not a note list`);
  return pattern;
}

function gridLane(draft: Project, patternId: string, laneName: string): { lane: GridLane; bars: number } {
  const pattern = gridPattern(draft, patternId);
  const lane = pattern.lanes.find((entry) => entry.lane === laneName);
  if (lane === undefined) throw new Error(`pattern "${patternId}" has no lane "${laneName}"`);
  return { lane, bars: barsOf(draft, pattern.lengthTicks) };
}

function barsOf(draft: Project, lengthTicks: number): number {
  const barTicks = ticksPerBar(draft.project.ppqn, draft.project.meterMap[0]!.timeSignature);
  const bars = lengthTicks / barTicks;
  if (!Number.isInteger(bars)) {
    throw new Error(`pattern length ${lengthTicks} is not a whole number of ${barTicks}-tick bars`);
  }
  return bars;
}

/**
 * The lane's hit steps, from the grammar's own parser.
 *
 * Every edit reads the string back through `parseSteps` instead of remembering
 * what it wrote, so a lane hand-edited to a different spacing — or to a different
 * number of bars — is read exactly as the compiler reads it.
 */
function hitsOf(lane: GridLane, patternId: string, bars: number): number[] {
  const parsed = parseSteps(lane.steps, {
    file: `patterns/${patternId}.json`,
    pointer: "",
    stepsPerBar: lane.grid.stepsPerBar,
    bars,
  });
  if (parsed.hits === undefined) {
    throw new Error(
      `lane "${lane.lane}" of "${patternId}" does not parse: ${parsed.diagnostics.map((d) => d.message).join("; ")}`,
    );
  }
  return parsed.hits;
}

/**
 * A lane name is a kit voice seen from the pattern side (docs/format-spec.md §5),
 * so creating a lane for a name no playing kit has would write a document
 * `validate` rejects as `pattern.lane-unknown-voice`. Checked against every track
 * that references the pattern, exactly as the validator does; a pattern no track
 * plays is not checked, because there is no kit to check against.
 */
function assertVoiceExists(draft: Project, patternId: string, laneName: string): void {
  for (const track of draft.tracks.values()) {
    if (!track.patterns.includes(patternId)) continue;
    const instrument = draft.instruments.get(track.instrument);
    if (instrument === undefined || instrument.type !== "drumkit") continue;
    if (!(laneName in instrument.kit)) {
      throw new Error(
        `cannot add lane "${laneName}" to "${patternId}": drumkit "${instrument.id}" on track "${track.id}" has no such voice`,
      );
    }
  }
}

/** Every grid step must be a whole number of ticks (docs/format-spec.md §5). */
function assertStepGrid(draft: Project, stepsPerBar: number): void {
  const barTicks = ticksPerBar(draft.project.ppqn, draft.project.meterMap[0]!.timeSignature);
  if (!Number.isInteger(stepsPerBar) || stepsPerBar <= 0 || barTicks % stepsPerBar !== 0) {
    throw new Error(`cannot use ${stepsPerBar} steps per bar: it must divide a bar's ${barTicks} ticks evenly`);
  }
}

/** permille fields, per PLAN.md §6.2. */
function checkPermille(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error(`${field} must be an integer permille in 0..1000, got ${value}`);
  }
}

function checkStepEventField(field: keyof StepEventPatch, value: number): void {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer, got ${value}`);
  if (field === "velocity" || field === "probability") return checkPermille(field, value);
  if (field === "gateTicks" && value <= 0) throw new Error(`gateTicks must be a positive tick count, got ${value}`);
  if (field === "ratchet" && value < 1) throw new Error(`ratchet must be at least 1, got ${value}`);
}

/**
 * The note rules an editor can break, refused before the model moves.
 *
 * Deliberately narrow: these mirror the schema and the semantic checks
 * (`note.pitch-out-of-range`, `note.start-out-of-range`) that `musictool validate`
 * owns, and they exist because writing a document the validator would reject is a
 * worse outcome than a thrown error the UI can show. The pitch rule is not
 * restated — `pitchToMidi` and the range constants come from the format package,
 * which is the only place that grammar lives.
 */
function checkNote(note: NoteEvent, pattern: NotesPatternDoc): void {
  const midi = pitchToMidi(note.pitch);
  if (midi === undefined) throw new Error(`"${note.pitch}" is not a pitch name this format accepts`);
  if (midi < LOWEST_MIDI || midi > HIGHEST_MIDI) {
    throw new Error(`pitch "${note.pitch}" is outside the MIDI range C-1..G9`);
  }
  if (!Number.isInteger(note.startTick) || note.startTick < 0) {
    throw new Error(`startTick must be a non-negative integer tick, got ${note.startTick}`);
  }
  if (note.startTick >= pattern.lengthTicks) {
    throw new Error(`startTick ${note.startTick} is past the end of a ${pattern.lengthTicks}-tick pattern`);
  }
  if (!Number.isInteger(note.durationTicks) || note.durationTicks <= 0) {
    throw new Error(`durationTicks must be a positive integer, got ${note.durationTicks}`);
  }
  checkPermille("velocity", note.velocity);
  if (note.probability !== undefined) checkPermille("probability", note.probability);
  if (note.microTicks !== undefined && !Number.isInteger(note.microTicks)) {
    throw new Error(`microTicks must be an integer, got ${note.microTicks}`);
  }
  if (note.ratchet !== undefined && (!Number.isInteger(note.ratchet) || note.ratchet < 1)) {
    throw new Error(`ratchet must be an integer of at least 1, got ${note.ratchet}`);
  }
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
