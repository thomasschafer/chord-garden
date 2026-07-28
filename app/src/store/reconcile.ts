import {
  assembleProject,
  docKindFromHint,
  docKindHintForPath,
  parseStrictJson,
  type AssembledFile,
  type Project,
} from "@chord-garden/format/pure";
import { hashText } from "./hash";

/**
 * An external edit, as the store needs it. The sidecar's `projectChanged`
 * message satisfies this shape; the store takes the interface rather than the
 * message so a test can hand it one without a socket, and so the reconcile has
 * no opinion about the transport.
 *
 * The sidecar only sends this for a snapshot that passed project-level
 * validation (PLAN.md §12), which is what makes adopting it safe.
 */
export interface ExternalChange {
  /**
   * Whether `changed` carries every document on disk (`full`) or only the ones the
   * sidecar believes this editor has not seen (`diff`).
   *
   * It decides what a document this editor holds and the inventory does not name
   * means. In a diff it means desynchronised — the sidecar names every removal it
   * knows about, so a file missing from the inventory and from `removed` is a
   * disagreement this window cannot explain. In a full snapshot — sent when this
   * window reconnected holding a state the sidecar had moved past — the sidecar
   * cannot know which removals this window already saw, so the inventory is the
   * authority and a document *this window believes is on disk* that it does not
   * name is gone. Only such files: a document this window created and has not
   * written yet is absent from every inventory there has ever been, and that says
   * nothing at all about it.
   */
  scope: "diff" | "full";
  /** Every document on disk after the change. */
  files: readonly { path: string; contentHash: string }[];
  /** Documents whose bytes the sidecar believes this editor has not seen. */
  changed: readonly { path: string; text: string; contentHash: string }[];
  removed: readonly string[];
  /**
   * The snapshot's own diagnostics — warnings only, since a snapshot with errors
   * is never sent. These *replace* whatever the store was showing: the previous
   * set described a disk state that no longer exists, and leaving an error from a
   * half-finished edit on screen after the edit has landed is a UI that lies.
   */
  diagnostics: readonly { severity: string; code: string; file: string; message: string }[];
}

/** What the store holds, as much of it as the reconcile needs. */
export interface ReconcileInput {
  project: Project;
  /** Canonical bytes of the current model, including unsaved local edits. */
  canonical: ReadonlyMap<string, string>;
  /** Bytes this editor believes are on disk, per path. */
  onDisk: ReadonlyMap<string, string>;
  /** Paths with unsaved local edits. */
  dirty: readonly string[];
  change: ExternalChange;
}

export type ReconcileResult =
  | { kind: "noop" }
  | { kind: "outOfSync"; message: string }
  | {
      kind: "adopt";
      project: Project;
      /** Paths taken from disk, with the exact bytes read there. */
      adopted: ReadonlyMap<string, string>;
      removed: readonly string[];
      /**
       * Adopted paths that had an unsaved local edit, which is now gone — either
       * unwritten bytes the disk's version replaced, or a local deletion the disk
       * contradicted by still having the file.
       */
      discarded: readonly string[];
    };

/**
 * Fold an external edit into the model (PLAN.md §12 step 4).
 *
 * Pure, and the whole decision, so that the interesting cases are testable
 * without a filesystem, a socket, or a browser.
 *
 * Three properties are worth stating outright, because each of them is a bug
 * class this project cannot afford:
 *
 * **An announcement of bytes we already have is nothing.** This is the browser's
 * own echo check, independent of the sidecar's. It is what makes reconciling
 * idempotent: a redundant snapshot — one that crossed with this editor's own
 * write, or arrived just after a reconnect's full reload — cannot discard an
 * unsaved local edit, because there is nothing new in it to discard the edit
 * *for*. Without it, a harmless duplicate push destroys work.
 *
 * **Whatever the disk says about a file it changed, wins.** PLAN.md §12's
 * concurrency policy is last-writer-wins with a visible warning, and on a file
 * the agent has just written, the agent *is* the last writer — its bytes are the
 * ones on disk, and this editor's unsaved version never landed. Keeping the local
 * version instead would mean deliberately overwriting the agent at the next
 * debounce, which is the one outcome PLAN.md §3 cannot tolerate. So the local
 * edit to that file is dropped and named in `discarded`; unsaved edits to files
 * the agent did *not* touch are untouched and still get written.
 *
 * **The model is rebuilt from bytes, never patched.** Every unchanged document
 * comes back through the canonical serializer and the strict parser, and the
 * result is assembled by the same `assembleProject` the CLI and the initial load
 * use. §12 step 5 defers semantic patches on purpose, and this is that deferral
 * taken seriously: there is one way to build a `Project` from documents, so a
 * reconciled model cannot differ in shape from a freshly loaded one.
 *
 * Anything that does not add up — an inventory naming a file this editor cannot
 * account for, a document the sidecar validated that will not parse here, bytes
 * whose hash disagrees with the sidecar's — returns `outOfSync` and changes
 * nothing. That is not a case to guess through: guessing means either dropping
 * the agent's edit or overwriting it.
 */
export function reconcileExternalChange(input: ReconcileInput): ReconcileResult {
  const { change, onDisk, canonical } = input;

  const inventory = new Map(change.files.map((file) => [file.path, file.contentHash]));
  const newly = change.changed.filter((file) => onDisk.get(file.path) !== file.text);

  // Documents the model and the disk disagree about because *this window* has not
  // written its own edits yet — a file created here and never flushed, or one the
  // model dropped whose deletion has not reached disk. Neither is anything the
  // sidecar can know about, so neither may be read as news about the disk.
  //
  // This distinction is the whole reason `onDisk` exists beside `canonical`, and
  // getting it wrong is silent: a locally created file compared against an
  // inventory that has never named it looks exactly like a file an agent deleted.
  const pendingCreates = new Set([...canonical.keys()].filter((path) => !onDisk.has(path)));
  const pendingDeletes = new Set([...onDisk.keys()].filter((path) => !canonical.has(path)));

  // A full snapshot's inventory is the authority on which documents exist, so a
  // document this window believes is *on disk* that it does not name is a removal
  // this window was never told about — a file deleted while its socket was down.
  // Compared against `onDisk` and never against `canonical`: the server cannot
  // have deleted a file it has never seen. In a diff only `removed` may say this.
  const gone = change.scope === "full" ? [...onDisk.keys()].filter((path) => !inventory.has(path)) : [];
  const removed = [...new Set([...change.removed, ...gone])].filter(
    (path) => canonical.has(path) || onDisk.has(path),
  );
  if (newly.length === 0 && removed.length === 0) return { kind: "noop" };

  const texts = new Map(canonical);
  for (const path of removed) texts.delete(path);
  for (const file of newly) texts.set(file.path, file.text);

  // The two consistency checks are about a disagreement this window cannot
  // explain, so each excuses the one case it *can*: a document still awaiting its
  // own write is expected to be on disk and not in the model, or in the model and
  // not on disk. Without that, any external edit arriving between a local
  // create-or-delete and its debounced write is a spurious desync.
  const unaccounted = [...inventory.keys()]
    .filter((path) => !texts.has(path) && !pendingDeletes.has(path))
    .sort();
  const unexpected = [...texts.keys()]
    .filter((path) => !inventory.has(path) && !pendingCreates.has(path))
    .sort();
  if (unaccounted.length > 0 || unexpected.length > 0) {
    return {
      kind: "outOfSync",
      message: `this window's copy of the project no longer matches the disk${
        unaccounted.length > 0 ? `; it has nothing for ${unaccounted.join(", ")}` : ""
      }${unexpected.length > 0 ? `; the disk has no ${unexpected.join(", ")}` : ""}`,
    };
  }

  // Every file the snapshot did not carry must be one whose disk bytes this
  // editor already holds, byte for byte. This is the check that catches a
  // snapshot built from a disk state this editor never saw — the one case where
  // adopting would produce a model that no validation ever passed.
  const carried = new Set(newly.map((file) => file.path));
  for (const [path, contentHash] of inventory) {
    const believed = carried.has(path) ? texts.get(path) : onDisk.get(path);
    if (believed === undefined) {
      return { kind: "outOfSync", message: `this window has never read "${path}", which the disk now has` };
    }
    if (hashText(believed) !== contentHash) {
      return {
        kind: "outOfSync",
        message: `"${path}" on disk is not the version this window last read, and the change did not include it`,
      };
    }
  }

  const documents: AssembledFile[] = [];
  for (const [path, text] of texts) {
    const hint = docKindHintForPath(path);
    if (hint === undefined) {
      return { kind: "outOfSync", message: `"${path}" is not a path this format's bundle layout allows` };
    }
    const parsed = parseStrictJson(text, path);
    if (parsed.value === undefined) {
      // The sidecar validated these bytes, so failing here means the two sides
      // disagree about what strict JSON is — not something to route around.
      return {
        kind: "outOfSync",
        message: `"${path}" did not parse in this window: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
      };
    }
    const kind = docKindFromHint(hint, parsed.value);
    if (kind === undefined) {
      return { kind: "outOfSync", message: `"${path}" does not say which kind of document it is` };
    }
    documents.push({ kind, value: parsed.value });
  }

  let project: Project;
  try {
    project = assembleProject(input.project.root, documents);
  } catch (error) {
    return {
      kind: "outOfSync",
      message: `the changed project could not be assembled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const adopted = new Map(newly.map((file) => [file.path, file.text]));
  return {
    kind: "adopt",
    project,
    adopted,
    removed: [...removed].sort(),
    // A local deletion the disk has just contradicted counts as a discarded edit
    // too: the file is back in the model, and saying nothing would let a document
    // the author deleted reappear with no explanation.
    discarded: [...adopted.keys()]
      .filter((path) => input.dirty.includes(path) || pendingDeletes.has(path))
      .sort(),
  };
}
