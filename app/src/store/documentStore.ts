import { effectParamEditEffect, paramEditEffect } from "@chord-garden/engine/params";
import {
  canonicalFiles,
  checkExpressionValue,
  checkParamValue,
  EFFECTS_MIN_FORMAT,
  formatSteps,
  ID_PATTERN,
  HIGHEST_MIDI,
  LOWEST_MIDI,
  NOTE_EXPRESSION_FIELDS,
  parseSteps,
  pitchToMidi,
  parseEffectParamKey,
  resolveEffectParam,
  resolveParam,
  resolveTrackParam,
  staticTrackParamValue,
  ticksPerBar,
  type AutomationDoc,
  type AutomationInterp,
  type AutomationLane,
  type EffectDoc,
  type EffectType,
  type ExpressionField,
  type GridLane,
  type GridPatternDoc,
  type InstrumentDoc,
  type LaneDefaults,
  type NoteEvent,
  type NotesPatternDoc,
  type ParamSpec,
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

/**
 * One document to remove from disk.
 *
 * Removal exists because `automation/<track>.json` may not hold zero lanes
 * (docs/format-spec.md §7 and the schema's `minItems`), so deleting a track's
 * last automation lane has nowhere to go except deleting the file. An editor
 * that can add a lane and cannot take the last one away is an editor with a
 * one-way door in it.
 */
export interface PendingDelete {
  path: string;
  /** Hash of the bytes this editor believes it is removing; never null. */
  expectedHash: string;
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
  write(files: readonly PendingFile[], deletes: readonly PendingDelete[]): Promise<WriteOutcome>;
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
  /**
   * Paths the model no longer has that the disk still does, sorted. Derived the
   * same way `dirty` is — by comparing the re-serialized project against the
   * baseline — so an edit cannot forget to declare that it dropped a document.
   */
  removing: readonly string[];
  /** Paths in the write batch currently in flight, written or removed. */
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
  /**
   * The project-wide swing, in permille (docs/format-spec.md §4). Structural:
   * every odd-indexed grid step in the project moves.
   */
  setProjectSwing(permille: number): void;
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
  /**
   * Set, change or clear a lane's `defaults`, the expression every hit in the
   * lane inherits. Same rules as `setStepEvent`: a field given as `undefined` is
   * removed, and a `defaults` object left with nothing in it is dropped, because
   * the schema's `minProperties` refuses an empty one and `fmt` would not write
   * it.
   */
  setLaneDefaults(patternId: string, lane: string, patch: LaneDefaultsPatch): void;
  /**
   * Change a lane's grid resolution, keeping every hit at the tick it is at now.
   *
   * Refused rather than rounded when a hit would not land on the new grid: a
   * coarser grid genuinely cannot hold an off-grid hit, and quietly moving or
   * dropping one is requantisation nobody asked for (PLAN.md §18's rule about
   * grids being a view). The refusal names every hit that blocks it, because
   * "one of your hits is in the way" is not something a musician can act on.
   *
   * `remapLaneStepsPerBar` is the other half: the same change with the author's
   * explicit consent to lose timing.
   */
  setLaneStepsPerBar(patternId: string, lane: string, stepsPerBar: number): void;
  /**
   * Change a lane's grid resolution, moving each hit to the nearest step of the
   * new grid and reporting exactly what that cost.
   *
   * The deliberately lossy half of the pair, and it exists because refusing alone
   * leaves a one-way door: a lane written at 16 with a hit on step 6 can never
   * become 12, and "delete the hit yourself first" is the editor asking the author
   * to do the destructive part by hand with no idea what else will move.
   *
   * The loss is bounded and stated, never silent. A hit already on a step of the
   * new grid does not move. A hit between steps moves to the nearer one. Two hits
   * the coarser grid puts on one step cannot both survive — the earlier one keeps
   * the step and the later is dropped, with its `stepEvents` overrides — and the
   * returned report names every hit in each category by the step index it had, for
   * the UI to show. Nothing about it is a guess the author has to discover by ear.
   */
  remapLaneStepsPerBar(patternId: string, lane: string, stepsPerBar: number): StepsPerBarRemap;
  /**
   * Set, change or clear one param of one instrument.
   *
   * `undefined` clears the override. So does a value equal to the registry
   * default, which is the same rule the velocity drag follows: the file says what
   * the author meant, and "the default" is said by the absence of a key, not by a
   * number that happens to equal it (docs/format-spec.md §6 — "omitting a param
   * means its default; `fmt` never writes defaults in for you"). An instrument
   * left overriding nothing loses its `params` object too, rather than keeping an
   * empty one.
   *
   * The audio classification is not this file's opinion: `paramEditEffect` answers
   * it from how the DSP is actually built, so a param the renderer reads per block
   * is heard in the next one and one it fixes when it constructs a voice waits for
   * a bar line.
   */
  setInstrumentParam(instrumentId: string, key: string, value: number | string | undefined): void;
  /**
   * The same, for several params of one instrument at once.
   *
   * One edit, not one per key, because some gestures are genuinely about a set of
   * params: pulling a whole drum kit down by 3 dB moves every voice's `gain`, and
   * as separate edits that is one recompile and one file write per voice for a
   * single drag of a single control. The effect is the strongest of the keys' — one
   * param the DSP fixes at construction makes the whole batch structural.
   */
  setInstrumentParams(instrumentId: string, patch: InstrumentParamPatch): void;
  /**
   * Set, change or clear one param of one effect on one track's chain.
   *
   * Same rules as an instrument param — `undefined` or the registry default clears
   * the key, and an effect overriding nothing loses its `params` object — and the
   * same classification: nothing in an effect is sized by a param value, so every
   * effect param edit is `parameters` and is heard in the next scheduling window.
   * The effect is addressed by `effectId`, never by chain position.
   */
  setEffectParam(trackId: string, effectId: string, param: string, value: number | string | undefined): void;
  /**
   * Append an effect to a track's chain.
   *
   * `structural`: a new effect is a new processor, so it needs a new graph and
   * lands at the next bar boundary. Also the point at which a format-1 project
   * becomes a format-2 one — see `promoteFormatForEffects`.
   */
  addEffect(trackId: string, effectId: string, type: EffectType): void;
  /**
   * Remove an effect, and every automation lane that targeted it.
   *
   * The lanes go because a lane naming an absent effect is `ref.missing-effect` —
   * leaving them would write a document `musictool validate` rejects, which is a
   * worse outcome than an edit that visibly takes the lanes with it.
   */
  removeEffect(trackId: string, effectId: string): void;
  /**
   * Move an effect to a new index in the chain, changing only the order audio
   * passes through it.
   *
   * `structural`, because the graph's shape changed — and deliberately *not* a
   * re-targeting: every automation lane still names the same effect afterwards,
   * because it names it by id. That is the whole reason effects carry ids
   * (PLAN.md §18: never key on an array position).
   */
  moveEffect(trackId: string, effectId: string, toIndex: number): void;
  /**
   * Start automating `param` on `track`, seeded with one point at tick 0 holding
   * the value the instrument already produces — so creating a lane changes
   * nothing until a point is moved. Creates `automation/<track>.json` if the
   * track has none.
   */
  addAutomationLane(trackId: string, param: string, interp?: AutomationInterp): void;
  /** Stop automating `param`; removes the track's automation file if it was the last lane. */
  removeAutomationLane(trackId: string, param: string): void;
  setAutomationInterp(trackId: string, param: string, interp: AutomationInterp): void;
  /** Add a breakpoint. Refused at a tick the lane already has a point at. */
  addAutomationPoint(trackId: string, param: string, tick: number, value: number): void;
  /**
   * Move one breakpoint. `tick` must stay strictly between its neighbours
   * (docs/format-spec.md §7) and inside the arrangement, and `value` must be in
   * the param's own registry range; anything else throws rather than being
   * clamped here. Dragging clamps before it calls this — see `view/automation.ts`
   * — so the clamp lives where the pointer is and the model stays strict.
   */
  moveAutomationPoint(trackId: string, param: string, index: number, tick: number, value: number): void;
  /** Remove a breakpoint. Refused for the last one: a lane must keep a point. */
  removeAutomationPoint(trackId: string, param: string, index: number): void;
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

/** The same present-and-`undefined`-means-remove rule, for a lane's `defaults`. */
export type LaneDefaultsPatch = {
  [K in keyof LaneDefaults]?: number | undefined;
};

/**
 * Params to set on one instrument. Present-and-`undefined` means "clear this
 * override", exactly as `StepEventPatch` does; a key that is absent is untouched.
 *
 * Keys are strings rather than a union of param names on purpose: the valid keys
 * are the registry's, they depend on the instrument (a drumkit's are per voice),
 * and the store checks each one against `resolveParam` before writing. A union
 * here would be a second copy of the registry in the type system that could not
 * express a drumkit's keys anyway.
 */
export type InstrumentParamPatch = Record<string, number | string | undefined>;

/**
 * What became of a lane's hits when `remapLaneStepsPerBar` changed its grid.
 *
 * Every hit the lane had appears in exactly one of `kept`, `moved` and `lost`, by
 * the step index it had in the old grid — which is the property the UI's summary
 * and `test/patternEdits.test.ts` both rest on. A hit cannot go missing from the
 * report without the arithmetic disagreeing with itself.
 */
export interface StepsPerBarRemap {
  from: number;
  to: number;
  /** Hits already on a step of the new grid; their tick did not change. */
  kept: readonly number[];
  /** Hits moved to the nearest step, as `[wasStep, nowStep]`. */
  moved: readonly (readonly [number, number])[];
  /** Hits dropped because an earlier hit had already claimed their new step. */
  lost: readonly number[];
  /** Of `lost`, the ones that also took `stepEvents` overrides with them. */
  lostOverrides: readonly number[];
}

/** Fields every note must have, which a patch may change but not remove. */
export const REQUIRED_NOTE_FIELDS = ["pitch", "startTick", "durationTicks", "velocity"] as const;
/**
 * Fields a note may carry, which a patch may also remove by passing `undefined`.
 * The format package's list, not a second one: a field added to the expression
 * registry becomes editable here without this file being touched.
 */
export const OPTIONAL_NOTE_FIELDS = NOTE_EXPRESSION_FIELDS;

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
      const revision = get().revision + 1;
      set({
        project: draft,
        canonical,
        dirty,
        removing: removed,
        revision,
        audioEdit: { revision, effect, project: draft },
      });
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
        return inFlight.then(() => (pendingWork(get()) ? flush() : undefined));
      }
      // A conflict is not a transient failure, so it is not retried. The edits
      // stay in the model and stay dirty; nothing more goes to disk until the
      // human reloads and decides what to do.
      if (get().conflict !== undefined) return Promise.resolve();
      if (!pendingWork(get())) return Promise.resolve();
      const dirty = get().dirty;
      const canonical = get().canonical;
      const onDisk = get().onDisk;
      const files = dirty.map((path) => {
        const contents = canonical.get(path);
        if (contents === undefined) throw new Error(`internal error: "${path}" is dirty but has no canonical bytes`);
        const believed = onDisk.get(path);
        return { path, contents, expectedHash: believed === undefined ? null : hashText(believed) };
      });
      // A path the model dropped that this editor never saw on disk needs no
      // deletion — there is nothing there to delete — so it is dropped from the
      // batch rather than sent with a precondition that cannot be satisfied.
      const deletes: PendingDelete[] = [];
      for (const path of get().removing) {
        const believed = onDisk.get(path);
        if (believed !== undefined) deletes.push({ path, expectedHash: hashText(believed) });
      }

      // What this editor believed about disk when the batch left, per path. Only
      // an accepted external edit can change that while a batch is open, and an
      // external edit is *newer news about the disk* than the ack of a write that
      // was already in flight. So the ack is not allowed to overwrite it — see
      // the filter in the success handler.
      const believedAtSend = new Map(
        [...files, ...deletes].map((file) => [file.path, onDisk.get(file.path)] as const),
      );

      set({ writing: [...dirty, ...deletes.map((file) => file.path)].sort(), lastWriteError: undefined });
      const run = options.sink
        .write(files, deletes)
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
          for (const file of deletes) {
            // The same rule as a write: an external edit adopted while this batch
            // was open is newer news than the batch's own ack. It cannot have been
            // adopted here without the server having refused the whole batch, but
            // the check costs nothing and the asymmetry would be invisible.
            if (written.get(file.path) !== believedAtSend.get(file.path)) continue;
            persisted.delete(file.path);
            written.delete(file.path);
          }
          const { dirty: stillDirty, removed: stillRemoving } = diffAgainst(persisted, get().canonical);
          set({
            persisted,
            onDisk: written,
            dirty: stillDirty,
            removing: stillRemoving,
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
      removing: [],
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
          removing: [],
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

      setProjectSwing(permille) {
        // Structural: swing displaces every odd-indexed grid step in the project
        // (docs/format-spec.md §4), so the events move and the scheduler would
        // refuse a softer claim.
        applyEdit("structural", (draft) => {
          const problem = checkExpressionValue("swing", permille);
          if (problem !== undefined) throw new Error(problem);
          draft.project.swing = permille;
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
              // Removed, never written back as the value it was inheriting. The
              // file stays as sparse as the author left it, and a diff shows the
              // one line that changed rather than five that were made explicit.
              delete merged[field];
              continue;
            }
            checkField(field, value);
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

      setLaneDefaults(patternId, laneName, patch) {
        applyEdit("structural", (draft) => {
          const { lane } = gridLane(draft, patternId, laneName);
          const merged: LaneDefaults = { ...(lane.defaults ?? {}) };
          for (const [field, value] of Object.entries(patch) as [keyof LaneDefaultsPatch, number | undefined][]) {
            if (value === undefined) {
              delete merged[field];
              continue;
            }
            checkField(field, value);
            merged[field] = value;
          }
          // `minProperties: 1` in the schema: an empty `defaults` is not a
          // document, so a lane that has stopped defaulting anything drops it.
          if (Object.keys(merged).length === 0) delete lane.defaults;
          else lane.defaults = merged;
        });
      },

      setLaneStepsPerBar(patternId, laneName, stepsPerBar) {
        applyEdit("structural", (draft) => {
          const { lane, bars } = gridLane(draft, patternId, laneName);
          assertStepGrid(draft, stepsPerBar);
          const from = lane.grid.stepsPerBar;
          if (stepsPerBar === from) return;
          const grid = regridOf(draft, from, stepsPerBar);
          const hits = hitsOf(lane, patternId, bars);

          // Every blocking hit, not the first one found. A lane is refused as a
          // whole, so naming one hit tells the author to fix it and try again, and
          // discover the next one — which is the interaction a validator exists to
          // prevent, arriving from the UI instead.
          const blocked = hits.filter((step) => !Number.isInteger(step * grid.ratio));
          if (blocked.length > 0) {
            const positions = blocked.map((step) => `${step} (tick ${step * grid.wasStepTicks})`).join(", ");
            throw new Error(
              `cannot change lane "${laneName}" from ${from} to ${stepsPerBar} steps per bar: ${blocked.length} of its ${hits.length} hits fall between steps of that grid — step ${positions}. Move or remove them, or remap the lane and accept that those hits shift.`,
            );
          }

          const moved = (step: number): number => step * grid.ratio;
          const stepEvents = lane.stepEvents?.map((entry) => ({ ...entry, step: moved(entry.step) }));
          lane.grid.stepsPerBar = stepsPerBar;
          lane.steps = formatSteps(hits.map(moved), stepsPerBar, bars);
          if (stepEvents !== undefined) lane.stepEvents = stepEvents.sort((a, b) => a.step - b.step);
        });
      },

      remapLaneStepsPerBar(patternId, laneName, stepsPerBar) {
        let report: StepsPerBarRemap | undefined;
        applyEdit("structural", (draft) => {
          const { lane, bars } = gridLane(draft, patternId, laneName);
          assertStepGrid(draft, stepsPerBar);
          const from = lane.grid.stepsPerBar;
          const grid = regridOf(draft, from, stepsPerBar);
          const total = stepsPerBar * bars;
          const overrides = new Map((lane.stepEvents ?? []).map((entry) => [entry.step, entry]));

          const kept: number[] = [];
          const shifted: [number, number][] = [];
          const lost: number[] = [];
          const lostOverrides: number[] = [];
          /** New step index -> the old step that claimed it. Ascending, so first wins. */
          const claimed = new Map<number, number>();
          const stepEvents: StepEvent[] = [];

          for (const step of hitsOf(lane, patternId, bars)) {
            const exact = step * grid.ratio;
            // Clamped, because a coarser grid can round the last hits of a pattern
            // past its final step: at 16 -> 4 the hit on step 15 rounds to step 4 of
            // a four-step bar, which does not exist. The clamp lands it on the last
            // step, where it either fits or collides and is reported as lost.
            const to = Math.min(total - 1, Math.max(0, Math.round(exact)));
            if (claimed.has(to)) {
              lost.push(step);
              if (overrides.has(step)) lostOverrides.push(step);
              continue;
            }
            claimed.set(to, step);
            if (Number.isInteger(exact)) kept.push(step);
            else shifted.push([step, to]);
            const override = overrides.get(step);
            if (override !== undefined) stepEvents.push({ ...override, step: to });
          }

          lane.grid.stepsPerBar = stepsPerBar;
          lane.steps = formatSteps([...claimed.keys()].sort((a, b) => a - b), stepsPerBar, bars);
          if (stepEvents.length === 0) delete lane.stepEvents;
          else lane.stepEvents = stepEvents.sort((a, b) => a.step - b.step);

          report = { from, to: stepsPerBar, kept, moved: shifted, lost, lostOverrides };
        });
        if (report === undefined) throw new Error("internal error: the regrid produced no report");
        return report;
      },

      setInstrumentParam(instrumentId, key, value) {
        // `get()`, not `this`: React hands an action to a component detached from the
        // state object (`useStore(documentStore, (s) => s.setInstrumentParam)`), so
        // `this` is undefined by the time a fader calls it. A test that reaches the
        // action as `getState().setInstrumentParam(...)` binds `this` and passes,
        // which is exactly how this survived until a fader was dragged in a browser.
        get().setInstrumentParams(instrumentId, { [key]: value });
      },

      setInstrumentParams(instrumentId, patch) {
        const current = get().project?.instruments.get(instrumentId);
        if (current === undefined) throw new Error(`no instrument "${instrumentId}"`);
        const entries = Object.entries(patch);
        if (entries.length === 0) throw new Error(`cannot set no params at all on "${instrumentId}"`);

        // Resolved and range-checked before anything moves, so a batch is all-or-nothing
        // and the document never holds a value `musictool validate` would reject.
        const specs = new Map<string, ParamSpec>();
        let effect: AudioEffect = "parameters";
        for (const [key, value] of entries) {
          const resolved = resolveParam(current, key);
          if (resolved === undefined) {
            throw new Error(`"${key}" is not a param of instrument "${instrumentId}"`);
          }
          if (value !== undefined) {
            const problem = checkParamValue(resolved.spec, value);
            if (problem !== undefined) {
              throw new Error(`${JSON.stringify(value)} is not a valid "${key}" value: ${problem}`);
            }
          }
          specs.set(key, resolved.spec);
          // Classified from the engine's own account of when the DSP reads each param,
          // so a claim of `parameters` the worklet would refuse cannot be made here.
          if (paramEditEffect(current, key) === "structural") effect = "structural";
        }

        applyEdit(effect, (draft) => {
          const instrument = draft.instruments.get(instrumentId);
          if (instrument === undefined) throw new Error(`no instrument "${instrumentId}"`);
          const params = { ...(instrument.params ?? {}) };
          for (const [key, value] of entries) {
            if (value === undefined || value === specs.get(key)!.default) delete params[key];
            else params[key] = value;
          }
          // An empty `params` is schema-legal and is still not a document anyone
          // wrote: it is two lines of noise in the diff of an instrument that has
          // stopped overriding anything.
          if (Object.keys(params).length === 0) delete instrument.params;
          else instrument.params = params;
        });
      },

      setEffectParam(trackId, effectId, param, value) {
        const project = get().project;
        if (project === undefined) throw new Error("no project is open");
        const effect = chainEffectOf(project, trackId, effectId);
        const spec = resolveEffectParam(effect.type, param);
        if (spec === undefined) {
          throw new Error(`"${param}" is not a param of the "${effect.type}" effect "${effectId}"`);
        }
        if (value !== undefined) {
          const problem = checkParamValue(spec, value);
          if (problem !== undefined) {
            throw new Error(`${JSON.stringify(value)} is not a valid "${param}" value: ${problem}`);
          }
        }
        // `effectParamEditEffect` rather than a literal, for the same reason
        // `setInstrumentParams` asks `paramEditEffect`: the engine owns the answer,
        // and the worklet refuses a claim it cannot honour.
        applyEdit(effectParamEditEffect(effect, param), (draft) => {
          const target = chainEffectOf(draft, trackId, effectId);
          const params = { ...(target.params ?? {}) };
          if (value === undefined || value === spec.default) delete params[param];
          else params[param] = value;
          if (Object.keys(params).length === 0) delete target.params;
          else target.params = params;
        });
      },

      addEffect(trackId, effectId, type) {
        if (!ID_PATTERN.test(effectId)) {
          throw new Error(`"${effectId}" is not a valid id; ids are lowercase kebab-case (${ID_PATTERN.source})`);
        }
        applyEdit("structural", (draft) => {
          const track = draft.tracks.get(trackId);
          if (track === undefined) throw new Error(`no track "${trackId}"`);
          const effects = track.effects ?? [];
          if (effects.some((effect) => effect.id === effectId)) {
            throw new Error(`track "${trackId}" already has an effect "${effectId}"; ids must be unique in a chain`);
          }
          track.effects = [...effects, { id: effectId, type }];
          promoteFormatForEffects(draft);
        });
      },

      removeEffect(trackId, effectId) {
        applyEdit("structural", (draft) => {
          const track = draft.tracks.get(trackId);
          if (track === undefined) throw new Error(`no track "${trackId}"`);
          const remaining = (track.effects ?? []).filter((effect) => effect.id !== effectId);
          if (remaining.length === (track.effects ?? []).length) {
            throw new Error(`track "${trackId}" has no effect "${effectId}"`);
          }
          if (remaining.length === 0) delete track.effects;
          else track.effects = remaining;

          const automation = draft.automation.get(trackId);
          if (automation === undefined) return;
          automation.lanes = automation.lanes.filter(
            (lane) => parseEffectParamKey(lane.param)?.effectId !== effectId,
          );
          // An automation document with no lanes is not one the schema accepts, so
          // the last lane takes the file with it, exactly as `removeAutomationLane`
          // does.
          if (automation.lanes.length === 0) draft.automation.delete(trackId);
        });
      },

      moveEffect(trackId, effectId, toIndex) {
        applyEdit("structural", (draft) => {
          const track = draft.tracks.get(trackId);
          if (track === undefined) throw new Error(`no track "${trackId}"`);
          const effects = [...(track.effects ?? [])];
          const from = effects.findIndex((effect) => effect.id === effectId);
          if (from < 0) throw new Error(`track "${trackId}" has no effect "${effectId}"`);
          if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= effects.length) {
            throw new Error(`cannot move "${effectId}" to index ${toIndex}: the chain has ${effects.length} effects`);
          }
          const [moved] = effects.splice(from, 1);
          effects.splice(toIndex, 0, moved!);
          track.effects = effects;
        });
      },

      /**
       * Every automation edit is a `parameters` change, and that is a claim worth
       * spelling out because it is the one place PLAN.md §12 step 6 is genuinely
       * interesting.
       *
       * An automation lane produces no events. `compile` builds `CompiledTrack.events`
       * from patterns and clips and `CompiledTrack.automation` beside it, and nothing
       * in an `automation/<track>.json` can reach the first: a lane cannot add, remove,
       * move, retime or re-velocity a single note. So the events the worklet already
       * holds past the horizon stay correct, and a filter sweep can be dragged and
       * heard in the next control block instead of at the next bar line — which is the
       * only way dragging a curve is usable at all. Deferring it to a bar would make a
       * sweep feel like a text field with a one-bar lag.
       *
       * That holds for adding and removing a lane too, not only for moving a point:
       * `AutomationRamps`' buffer is keyed by the instrument's whole automatable param
       * set, so every registry-legal lane already has a slot, and a removed lane falls
       * back to the instrument's static value with nothing to rebuild.
       *
       * It is checked rather than trusted. `LiveScheduler.updateParameters` recompiles
       * and compares every event from the horizon on, and throws if one moved — so if
       * this reasoning is ever made false by a change to the compiler, the failure is
       * an error naming the divergence, not audio that quietly stops matching the file.
       */
      addAutomationLane(trackId, param, interp = "linear") {
        applyEdit("parameters", (draft) => {
          resolveAutomatable(draft, trackId, param);
          const existing = draft.automation.get(trackId);
          if (existing?.lanes.some((lane) => lane.param === param) === true) {
            throw new Error(`track "${trackId}" already automates "${param}"; a param may have only one lane`);
          }
          const seed = staticTrackParamValue(instrumentOf(draft, trackId), draft.tracks.get(trackId)?.effects, param);
          if (seed === undefined) {
            throw new Error(`cannot automate "${param}" on "${trackId}": it has no numeric value to start from`);
          }
          // One point at tick 0 holding what the instrument already produces, so
          // the lane is audible only once it is shaped. A lane seeded at the
          // param's minimum would silently rewrite the sound the moment it was
          // added.
          const lane: AutomationLane = { param, interp, points: [[0, seed]] };
          if (existing === undefined) {
            const doc: AutomationDoc = { track: trackId, lanes: [lane] };
            draft.automation.set(trackId, doc);
          } else {
            existing.lanes.push(lane);
          }
        });
      },

      removeAutomationLane(trackId, param) {
        applyEdit("parameters", (draft) => {
          const { doc, index } = automationLane(draft, trackId, param);
          doc.lanes.splice(index, 1);
          // A document with no lanes is not a document the schema accepts, so the
          // last lane takes the file with it. The write path expresses that as a
          // deletion; see `PendingDelete`.
          if (doc.lanes.length === 0) draft.automation.delete(trackId);
        });
      },

      setAutomationInterp(trackId, param, interp) {
        applyEdit("parameters", (draft) => {
          automationLane(draft, trackId, param).lane.interp = interp;
        });
      },

      addAutomationPoint(trackId, param, tick, value) {
        applyEdit("parameters", (draft) => {
          const { lane, spec } = automationLane(draft, trackId, param);
          checkAutomationTick(draft, tick);
          checkAutomationValue(spec, param, value);
          if (lane.points.some((point) => point[0] === tick)) {
            throw new Error(`"${param}" already has a point at tick ${tick}; points must be strictly increasing`);
          }
          lane.points.push([tick, value]);
          lane.points.sort((left, right) => left[0] - right[0]);
        });
      },

      moveAutomationPoint(trackId, param, index, tick, value) {
        applyEdit("parameters", (draft) => {
          const { lane, spec } = automationLane(draft, trackId, param);
          const point = lane.points[index];
          if (point === undefined) {
            throw new Error(`"${param}" on "${trackId}" has ${lane.points.length} points, so there is no point ${index}`);
          }
          checkAutomationTick(draft, tick);
          checkAutomationValue(spec, param, value);
          const before = lane.points[index - 1]?.[0];
          const after = lane.points[index + 1]?.[0];
          if (before !== undefined && tick <= before) {
            throw new Error(`tick ${tick} is not after the previous point at ${before}; points must be strictly increasing`);
          }
          if (after !== undefined && tick >= after) {
            throw new Error(`tick ${tick} is not before the next point at ${after}; points must be strictly increasing`);
          }
          lane.points[index] = [tick, value];
        });
      },

      removeAutomationPoint(trackId, param, index) {
        applyEdit("parameters", (draft) => {
          const { lane } = automationLane(draft, trackId, param);
          if (lane.points[index] === undefined) {
            throw new Error(`"${param}" on "${trackId}" has ${lane.points.length} points, so there is no point ${index}`);
          }
          if (lane.points.length === 1) {
            throw new Error(
              `"${param}" on "${trackId}" has only one point, and a lane must keep at least one. Remove the lane instead.`,
            );
          }
          lane.points.splice(index, 1);
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
        const { dirty, removed: removing } = diffAgainst(persisted, canonical);
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
          removing,
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
        if (dirty.length > 0 || removing.length > 0) scheduleFlush();
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
    if (!Object.hasOwn(instrument.kit, laneName)) {
      throw new Error(
        `cannot add lane "${laneName}" to "${patternId}": drumkit "${instrument.id}" on track "${track.id}" has no such voice`,
      );
    }
  }
}

/**
 * The arithmetic both grid changes share: how long a step was, and what an old
 * step index becomes in the new grid.
 *
 * `ratio` is the whole point of a shared helper. A step's *tick* is what has to be
 * preserved, and the tick cancels out — `step * wasStepTicks / nowStepTicks` is
 * `step * to / from` — so the two actions agree by construction on which hits land
 * exactly and where the rest go, rather than by two similar-looking expressions
 * happening to match.
 */
function regridOf(draft: Project, from: number, to: number): { wasStepTicks: number; ratio: number } {
  const barTicks = ticksPerBar(draft.project.ppqn, draft.project.meterMap[0]!.timeSignature);
  return { wasStepTicks: barTicks / from, ratio: to / from };
}

/** Every grid step must be a whole number of ticks (docs/format-spec.md §5). */
function assertStepGrid(draft: Project, stepsPerBar: number): void {
  const barTicks = ticksPerBar(draft.project.ppqn, draft.project.meterMap[0]!.timeSignature);
  if (!Number.isInteger(stepsPerBar) || stepsPerBar <= 0 || barTicks % stepsPerBar !== 0) {
    throw new Error(`cannot use ${stepsPerBar} steps per bar: it must divide a bar's ${barTicks} ticks evenly`);
  }
}

/**
 * Refuse a value the expression registry does not allow.
 *
 * The ranges are not restated here. `EXPRESSION_FIELDS` is where velocity is
 * permille and ratchet is at least one, the compiler reads its defaults from the
 * same table, and `packages/format/test/expressionSchema.test.ts` pins it to the
 * JSON Schemas — so a bound this store enforced on its own would be a fourth
 * copy waiting to disagree with the validator.
 */
function checkField(field: ExpressionField, value: number): void {
  const problem = checkExpressionValue(field, value);
  if (problem !== undefined) throw new Error(problem);
}

/**
 * Raise `project.json` `format` to 2 when the project has gained a feature that
 * needs it, and never otherwise.
 *
 * A document's existing version is preserved rather than promoted: a format-1
 * project edited in the UI keeps writing `"format": 1`, so opening the app cannot
 * quietly age every project a user owns out of a format-1 tool's reach.
 *
 * When it does promote, it does so because the document now *has* an effect chain
 * and a format-1 document may not (`format.effects-require-2`) — that is, the
 * alternative is writing a file `musictool validate` rejects. `AGENTS.md` tells
 * agents never to bump `format` themselves, so this is the tool doing it on their
 * behalf and it must be visible: it lands in `project.json` as a one-line diff in
 * the same write batch as the chain that required it, next to the chain in the
 * track file, and it is the only edit in this store that touches `format` at all.
 */
function promoteFormatForEffects(draft: Project): void {
  const needsEffects = [...draft.tracks.values()].some((track) => (track.effects ?? []).length > 0);
  if (needsEffects && draft.project.format < EFFECTS_MIN_FORMAT) {
    draft.project.format = EFFECTS_MIN_FORMAT;
  }
}

/** One effect of one track's chain, addressed by id. */
function chainEffectOf(project: Project, trackId: string, effectId: string): EffectDoc {
  const track = project.tracks.get(trackId);
  if (track === undefined) throw new Error(`no track "${trackId}"`);
  const effect = (track.effects ?? []).find((candidate) => candidate.id === effectId);
  if (effect === undefined) throw new Error(`track "${trackId}" has no effect "${effectId}"`);
  return effect;
}

function instrumentOf(draft: Project, trackId: string): InstrumentDoc {
  const track = draft.tracks.get(trackId);
  if (track === undefined) throw new Error(`no track "${trackId}"`);
  const instrument = draft.instruments.get(track.instrument);
  if (instrument === undefined) {
    throw new Error(`track "${trackId}" names instrument "${track.instrument}", which does not exist`);
  }
  return instrument;
}

/**
 * The registry entry an automation lane may target, or a refusal saying which
 * rule it broke. Both diagnostics `musictool validate` would emit
 * (`registry.unknown-param`, `automation.param-not-automatable`) are refused
 * here, before the document moves — writing a file the validator rejects is a
 * worse outcome than a thrown error the UI can show.
 */
function resolveAutomatable(draft: Project, trackId: string, param: string): ParamSpec {
  const instrument = instrumentOf(draft, trackId);
  // Resolved against the track, so `fx.<id>.<param>` on its effect chain is a
  // legal target beside every instrument param (docs/format-spec.md §7).
  const resolved = resolveTrackParam(instrument, draft.tracks.get(trackId)?.effects, param);
  if (resolved === undefined) {
    throw new Error(`"${param}" is not a param of track "${trackId}"`);
  }
  if (!resolved.spec.automatable) {
    throw new Error(`"${param}" is not automatable`);
  }
  return resolved.spec;
}

function automationLane(
  draft: Project,
  trackId: string,
  param: string,
): { doc: AutomationDoc; lane: AutomationLane; index: number; spec: ParamSpec } {
  const doc = draft.automation.get(trackId);
  if (doc === undefined) throw new Error(`track "${trackId}" has no automation`);
  const index = doc.lanes.findIndex((lane) => lane.param === param);
  const lane = doc.lanes[index];
  if (lane === undefined) throw new Error(`track "${trackId}" has no automation lane for "${param}"`);
  return { doc, lane, index, spec: resolveAutomatable(draft, trackId, param) };
}

/** Automation ticks are song time, so the arrangement is the bound (§7). */
function checkAutomationTick(draft: Project, tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`an automation point's tick must be a non-negative integer, got ${tick}`);
  }
  if (tick > draft.arrangement.lengthTicks) {
    throw new Error(`tick ${tick} is past the arrangement's ${draft.arrangement.lengthTicks} ticks`);
  }
}

/** The value is in the param's own unit and range, checked by the registry. */
function checkAutomationValue(spec: ParamSpec, param: string, value: number): void {
  const problem = checkParamValue(spec, value);
  if (problem !== undefined) throw new Error(`${value} is not a valid "${param}" value: ${problem}`);
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
  checkField("velocity", note.velocity);
  for (const field of NOTE_EXPRESSION_FIELDS) {
    const value = note[field];
    if (value !== undefined) checkField(field, value);
  }
}

/** Whether there is anything left to send: bytes to write, or a file to remove. */
function pendingWork(state: DocumentState): boolean {
  return state.dirty.length > 0 || state.removing.length > 0;
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
