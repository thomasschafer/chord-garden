import { describe, expect, it } from "vitest";
import {
  createDocumentStore,
  hashText,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
  type ExternalChange,
  type PendingDelete,
  type PendingFile,
} from "../src/store/documentStore";
import { FIXTURE, openedFrom } from "./fixture";

/** Records what it was asked to write, and resolves immediately. */
class RecordingSink implements DocumentSink {
  readonly batches: PendingFile[][] = [];
  readonly deleteBatches: PendingDelete[][] = [];

  async write(files: readonly PendingFile[], deletes: readonly PendingDelete[] = []) {
    this.batches.push(files.map((file) => ({ ...file })));
    this.deleteBatches.push(deletes.map((entry) => ({ ...entry })));
    return { diagnostics: [] };
  }

  get paths(): string[][] {
    return this.batches.map((batch) => batch.map((file) => file.path));
  }

  get deletedPaths(): string[][] {
    return this.deleteBatches.map((batch) => batch.map((entry) => entry.path));
  }
}

/** A sink whose writes only complete when the test says so. */
class DeferredSink implements DocumentSink {
  readonly batches: PendingFile[][] = [];
  private resolvers: (() => void)[] = [];

  async write(files: readonly PendingFile[]) {
    this.batches.push(files.map((file) => ({ ...file })));
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return { diagnostics: [] };
  }

  releaseAll(): void {
    for (const resolve of this.resolvers.splice(0)) resolve();
  }
}

function open(sink: DocumentSink, debounceMs = 10_000): DocumentStore {
  const store = createDocumentStore({ sink, debounceMs });
  store.getState().open(openedFrom(FIXTURE));
  return store;
}

/**
 * Build the message the sidecar would send for a set of edits on disk.
 *
 * The inventory is derived from what this window believes plus the edits, which
 * is exactly what the sidecar computes from the disk it just validated — so a
 * test that lies about one has to lie about both, and the store's consistency
 * check stays meaningful.
 */
function externalChange(
  store: DocumentStore,
  edits: Record<string, string>,
  removed: string[] = [],
  diagnostics: ExternalChange["diagnostics"] = [],
): ExternalChange {
  const disk = new Map(store.getState().onDisk);
  for (const path of removed) disk.delete(path);
  for (const [path, text] of Object.entries(edits)) disk.set(path, text);
  return {
    scope: "diff",
    files: [...disk].map(([path, text]) => ({ path, contentHash: hashText(text) })),
    changed: Object.entries(edits).map(([path, text]) => ({ path, text, contentHash: hashText(text) })),
    removed,
    diagnostics,
  };
}

/**
 * The full snapshot the sidecar sends a reconnecting window: every document on the
 * disk it just read, with its bytes, and no `removed` list — the inventory is what
 * says a document is gone (PLAN.md §12).
 *
 * `disk` is the whole disk, not a set of edits, because that is what the message
 * means; a helper that took edits would hide the case this exists to test.
 */
function fullSnapshot(disk: Record<string, string>): ExternalChange {
  const files = Object.entries(disk).map(([path, text]) => ({ path, text, contentHash: hashText(text) }));
  return {
    scope: "full",
    files: files.map(({ path, contentHash }) => ({ path, contentHash })),
    changed: files,
    removed: [],
    diagnostics: [],
  };
}

/** Every document this window believes is on disk, as the sidecar would read them. */
function diskOf(store: DocumentStore): Record<string, string> {
  return Object.fromEntries(store.getState().onDisk);
}

/**
 * Edit a document the way something outside this window would: starting from the
 * bytes on disk, not from the local model, which may have unsaved edits the agent
 * has never seen. Fails loudly if the replacement finds nothing, because a helper
 * that quietly returns the original text turns into a test that asserts nothing.
 */
function diskEdit(store: DocumentStore, path: string, from: string, to: string): string {
  const text = store.getState().onDisk.get(path);
  if (text === undefined) throw new Error(`the fixture has no ${path} on disk`);
  const changed = text.replace(from, to);
  if (changed === text) throw new Error(`${path} on disk does not contain ${from}`);
  return changed;
}

/** The project document with a different name, still canonical. */
function renamed(store: DocumentStore, name: string): string {
  return diskEdit(store, "project.json", '"name": "first track"', `"name": ${JSON.stringify(name)}`);
}

/** The drum pattern with one more kick, still canonical. */
function extraKick(store: DocumentStore): string {
  return diskEdit(
    store,
    "patterns/drums-verse.json",
    '"steps": "x..x ..x. x..x ..x."',
    '"steps": "x..x ..x. x..x ..xx"',
  );
}

describe("adopting an external edit", () => {
  it("replaces the affected document and writes nothing back", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const revision = store.getState().revision;
    const agentText = extraKick(store);

    store.getState().applyExternalChange(externalChange(store, { "patterns/drums-verse.json": agentText }));

    const state = store.getState();
    const lane = state.project!.patterns.get("drums-verse")!;
    expect(lane.kind === "grid" && lane.lanes[0]!.steps).toBe("x..x ..x. x..x ..xx");
    expect(state.revision).toBeGreaterThan(revision);
    expect(state.lastExternalEdit).toMatchObject({ adopted: ["patterns/drums-verse.json"], discarded: [] });
    // An accepted external edit is a new baseline, not an edit of ours.
    expect(state.dirty).toEqual([]);
    expect(state.onDisk.get("patterns/drums-verse.json")).toBe(agentText);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("leaves documents the edit did not touch alone", () => {
    const store = open(new RecordingSink());
    const before = store.getState().project!.patterns.get("bass-main");

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Renamed on disk") }));

    expect(store.getState().project!.project.name).toBe("Renamed on disk");
    expect(store.getState().project!.patterns.get("bass-main")).toEqual(before);
  });

  it("hands the new model to the audio engine as a structural change", () => {
    const store = open(new RecordingSink());

    store.getState().applyExternalChange(externalChange(store, { "patterns/drums-verse.json": extraKick(store) }));

    const edit = store.getState().audioEdit;
    expect(edit?.effect).toBe("structural");
    expect(edit?.project).toBe(store.getState().project);
    expect(edit?.revision).toBe(store.getState().revision);
  });

  it("adopts a valid but non-canonical external edit without rewriting it", async () => {
    // The loop this guards against: if the raw disk bytes became the baseline, the
    // file would read as dirty, the UI would write the canonical form back, the
    // watcher would see that write, and round it goes.
    const sink = new RecordingSink();
    const store = open(sink);
    const scruffy = `${extraKick(store)}\n`;

    store.getState().applyExternalChange(externalChange(store, { "patterns/drums-verse.json": scruffy }));

    expect(store.getState().dirty).toEqual([]);
    expect(store.getState().unformatted).toEqual(["patterns/drums-verse.json"]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("drops a document the agent deleted, and does not put it back", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    expect(store.getState().project!.automation.has("pad")).toBe(true);

    store.getState().applyExternalChange(externalChange(store, {}, ["automation/pad.json"]));

    expect(store.getState().project!.automation.has("pad")).toBe(false);
    expect(store.getState().canonical.has("automation/pad.json")).toBe(false);
    expect(store.getState().dirty).toEqual([]);
    expect(store.getState().lastExternalEdit?.removed).toEqual(["automation/pad.json"]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
    // The model still edits normally afterwards: nothing is left half-removed.
    store.getState().setProjectName("After a deletion");
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["project.json"]]);
  });

  it("does nothing at all before a project is open", () => {
    const store = createDocumentStore({ sink: new RecordingSink() });

    store.getState().applyExternalChange({
      scope: "diff",
      files: [{ path: "project.json", contentHash: "whatever" }],
      changed: [{ path: "project.json", text: "{}", contentHash: "whatever" }],
      removed: [],
      diagnostics: [],
    });

    expect(store.getState().project).toBeUndefined();
    expect(store.getState().outOfSync).toBeUndefined();
  });
});

describe("echo detection in the browser", () => {
  it("treats an announcement of bytes it already has as nothing", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().setProjectName("Written here");
    await store.getState().flushNow();
    const revision = store.getState().revision;

    // The bytes this window itself just wrote, announced back to it. The sidecar's
    // own echo check should stop this ever being sent; if it is sent anyway — a
    // redundant snapshot, a reconnect, a bug on that side — it must still be inert
    // here, or one duplicate push discards a person's unsaved work.
    const ourOwnBytes = store.getState().onDisk.get("project.json")!;
    expect(ourOwnBytes).toContain('"name": "Written here"');
    store.getState().applyExternalChange(externalChange(store, { "project.json": ourOwnBytes }));

    expect(store.getState().revision).toBe(revision);
    expect(store.getState().lastExternalEdit).toBeUndefined();
    expect(store.getState().externalEditsAccepted).toBe(0);
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["project.json"]]);
  });

  it("does not discard an unsaved edit for a redundant announcement", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const onDiskNow = store.getState().onDisk.get("project.json")!;

    store.getState().setProjectName("Still being typed");
    // A snapshot that carries the bytes already on disk: nothing has happened,
    // and the unsaved edit must survive it.
    store.getState().applyExternalChange(externalChange(store, { "project.json": onDiskNow }));

    expect(store.getState().project!.project.name).toBe("Still being typed");
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(store.getState().lastExternalEdit).toBeUndefined();
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["project.json"]]);
  });
});

describe("an invalid project on disk", () => {
  it("keeps the last valid model and shows the diagnostics", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const before = store.getState().project;
    const revision = store.getState().revision;

    store.getState().noteDiskInvalid([
      { severity: "error", code: "pattern.step-count-mismatch", file: "patterns/drums-verse.json", message: "12 steps, expected 16" },
    ]);

    const state = store.getState();
    expect(state.diskValid).toBe(false);
    // The model is untouched, object identity included: the engine is still
    // playing this exact snapshot.
    expect(state.project).toBe(before);
    expect(state.revision).toBe(revision);
    expect(state.diagnostics[0]!.code).toBe("pattern.step-count-mismatch");
    expect(state.outOfSync).toBeUndefined();
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("recovers when the edit finishes, adopting every file at once", () => {
    const store = open(new RecordingSink());

    store.getState().noteDiskInvalid([
      { severity: "error", code: "pattern.step-count-mismatch", file: "patterns/drums-verse.json", message: "mid-edit" },
    ]);
    store.getState().applyExternalChange(
      externalChange(store, {
        "patterns/drums-verse.json": extraKick(store),
        "project.json": renamed(store, "Both files"),
      }),
    );

    const state = store.getState();
    expect(state.diskValid).toBe(true);
    expect(state.project!.project.name).toBe("Both files");
    expect(state.lastExternalEdit?.adopted).toEqual(["patterns/drums-verse.json", "project.json"]);
  });

  it("clears the diagnostics that described the broken version", () => {
    // Caught in a browser rather than here first: the model recovered and the
    // step sequencer redrew, while the error from the half-finished edit stayed
    // on screen underneath it. A stale diagnostic is a UI telling the human the
    // project is broken when it is not.
    const store = open(new RecordingSink());
    store.getState().noteDiskInvalid([
      { severity: "error", code: "pattern.step-count-mismatch", file: "patterns/drums-verse.json", message: "12 of 16" },
    ]);

    store.getState().applyExternalChange(externalChange(store, { "patterns/drums-verse.json": extraKick(store) }));

    expect(store.getState().diagnostics).toEqual([]);
  });

  it("shows the warnings a valid snapshot still carries", () => {
    const store = open(new RecordingSink());
    const warning = { severity: "warning", code: "orphan.pattern", file: "patterns/unused.json", message: "no track plays this" };

    store.getState().applyExternalChange(
      externalChange(store, { "project.json": renamed(store, "With a warning") }, [], [warning]),
    );

    expect(store.getState().diagnostics).toEqual([warning]);
  });

  it("still lets an unrelated local edit be written while the disk is broken", async () => {
    // The precondition on each file is what protects the broken one; there is no
    // reason to stop the human editing a pattern the agent is not touching.
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().noteDiskInvalid([{ severity: "error", code: "any", file: "patterns/drums-verse.json", message: "broken" }]);

    store.getState().setProjectName("Carrying on");
    await store.getState().flushNow();

    expect(sink.paths).toEqual([["project.json"]]);
  });
});

describe("an external edit landing on unsaved local edits", () => {
  it("lets the disk win for that file, and says which edit it replaced", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().setProjectName("Typed here, never saved");
    expect(store.getState().dirty).toEqual(["project.json"]);

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Written by the agent") }));

    const state = store.getState();
    // PLAN.md §12: last-writer-wins with a visible warning. The agent's bytes are
    // the ones on disk; this window's version never landed.
    expect(state.project!.project.name).toBe("Written by the agent");
    expect(state.lastExternalEdit?.discarded).toEqual(["project.json"]);
    expect(state.dirty).toEqual([]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("keeps unsaved edits to files the external edit did not touch", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().setProjectName("Mine");
    store.getState().setPatternLaneSteps("drums-verse", "hat", "x.x. x.x. x.x. x.xx");
    expect(store.getState().dirty).toEqual(["patterns/drums-verse.json", "project.json"]);

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Theirs") }));

    expect(store.getState().project!.project.name).toBe("Theirs");
    expect(store.getState().lastExternalEdit?.discarded).toEqual(["project.json"]);
    // The pattern edit is untouched and still owed a write.
    expect(store.getState().dirty).toEqual(["patterns/drums-verse.json"]);
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["patterns/drums-verse.json"]]);
  });

  it("does not let a write already in flight overwrite the edit that replaced it", async () => {
    // The ordering that makes this subtle: the batch left before the external edit
    // arrived, so its acknowledgement is older news about the disk than the
    // snapshot already adopted. Believing the ack would leave a precondition that
    // does not match reality and a file that looks dirty, which is how the UI ends
    // up overwriting the agent one debounce later.
    const sink = new DeferredSink();
    const store = open(sink);
    store.getState().setProjectName("Ours, in flight");
    const writing = store.getState().flushNow();
    expect(sink.batches).toHaveLength(1);

    const agentText = renamed(store, "Theirs, on disk");
    store.getState().applyExternalChange(externalChange(store, { "project.json": agentText }));

    sink.releaseAll();
    await writing;

    const state = store.getState();
    expect(state.project!.project.name).toBe("Theirs, on disk");
    expect(state.onDisk.get("project.json")).toBe(agentText);
    expect(state.dirty).toEqual([]);
    expect(state.lastExternalEdit?.discarded).toEqual(["project.json"]);
  });
});

describe("a conflict the watcher can explain", () => {
  it("resumes writing once the external edit behind it has been adopted", async () => {
    let conflictNext = true;
    const written: string[][] = [];
    const sink: DocumentSink = {
      async write(files) {
        if (conflictNext) {
          conflictNext = false;
          throw new WriteConflictError("project.json changed on disk", files.map((file) => file.path));
        }
        written.push(files.map((file) => file.path));
        return { diagnostics: [] };
      },
    };
    const store = open(sink);

    store.getState().setProjectName("Refused");
    await store.getState().flushNow();
    expect(store.getState().conflict?.paths).toEqual(["project.json"]);

    // The watcher then delivers the edit that caused the 409. With that, the
    // disagreement is explained, so the dead end opens.
    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "The other editor's") }));

    expect(store.getState().conflict).toBeUndefined();
    expect(store.getState().project!.project.name).toBe("The other editor's");

    store.getState().setPatternLaneSteps("drums-verse", "hat", "x.x. x.x. x.x. x.xx");
    await store.getState().flushNow();
    expect(written).toEqual([["patterns/drums-verse.json"]]);
  });

  it("keeps the conflict when the external edit does not explain it", async () => {
    const sink: DocumentSink = {
      async write(files) {
        throw new WriteConflictError("both files changed", files.map((file) => file.path));
      },
    };
    const store = open(sink);
    store.getState().setProjectName("One");
    store.getState().setPatternLaneSteps("drums-verse", "hat", "x.x. x.x. x.x. x.xx");
    await store.getState().flushNow();
    expect(store.getState().conflict?.paths).toHaveLength(2);

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Only one of them") }));

    // The pattern is still unexplained, so writing stays paused and the human is
    // still being told about it.
    expect(store.getState().conflict?.paths).toEqual(["patterns/drums-verse.json", "project.json"]);
  });
});

describe("refusing to guess", () => {
  it("reports being out of sync when the inventory names a file it has never read", () => {
    const store = open(new RecordingSink());
    const before = store.getState().project;
    const change = externalChange(store, { "project.json": renamed(store, "Fine") });

    store.getState().applyExternalChange({
      ...change,
      files: [...change.files, { path: "patterns/appeared-from-nowhere.json", contentHash: "abc-1" }],
    });

    expect(store.getState().outOfSync).toContain("patterns/appeared-from-nowhere.json");
    expect(store.getState().project).toBe(before);
  });

  it("reports being out of sync when an untouched file's hash disagrees", () => {
    // The torn-read case: the snapshot was validated against a disk state this
    // window does not hold, so adopting it would build a model no validation ever
    // saw.
    const store = open(new RecordingSink());
    const before = store.getState().project;
    const change = externalChange(store, { "project.json": renamed(store, "Fine") });

    store.getState().applyExternalChange({
      ...change,
      files: change.files.map((file) =>
        file.path === "patterns/bass-main.json" ? { ...file, contentHash: "deadbeef-9" } : file,
      ),
    });

    expect(store.getState().outOfSync).toContain("patterns/bass-main.json");
    expect(store.getState().project).toBe(before);
  });

  it("reports being out of sync when the disk has lost a file the change did not mention", () => {
    const store = open(new RecordingSink());
    const change = externalChange(store, { "project.json": renamed(store, "Fine") });

    store.getState().applyExternalChange({
      ...change,
      files: change.files.filter((file) => file.path !== "tracks/bass.json"),
    });

    expect(store.getState().outOfSync).toContain("tracks/bass.json");
  });

  it("stops reconciling once it is out of sync", () => {
    const store = open(new RecordingSink());
    store.getState().noteOutOfSync("desynchronised");
    const before = store.getState().project;

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Ignored") }));

    expect(store.getState().project).toBe(before);
  });

  it("clears out-of-sync only by reopening", () => {
    const store = open(new RecordingSink());
    store.getState().noteOutOfSync("desynchronised");

    store.getState().open(openedFrom(FIXTURE));

    expect(store.getState().outOfSync).toBeUndefined();
  });
});

describe("catching up after a dropped connection", () => {
  /**
   * The sidecar sends a full snapshot when a reconnecting window says it holds a
   * disk state that has since moved (PLAN.md §12). It is the same reconcile — the
   * one difference is that the inventory, rather than `removed`, is what says a
   * document is gone, because the sidecar cannot know which removals this window
   * already saw.
   */
  it("adopts what moved and keeps unsaved edits to what did not", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().setPatternLaneSteps("drums-verse", "hat", "x.x. x.x. x.x. x.xx");
    expect(store.getState().dirty).toEqual(["patterns/drums-verse.json"]);
    const agentText = renamed(store, "Renamed while this window was offline");

    store.getState().applyExternalChange(fullSnapshot({ ...diskOf(store), "project.json": agentText }));

    const state = store.getState();
    expect(state.project!.project.name).toBe("Renamed while this window was offline");
    // The pattern edit was never on disk and the disk did not touch that file, so it
    // survives and is still owed a write.
    expect(state.dirty).toEqual(["patterns/drums-verse.json"]);
    expect(state.lastExternalEdit?.adopted).toEqual(["project.json"]);
    expect(state.lastExternalEdit?.discarded).toEqual([]);
    expect(state.outOfSync).toBeUndefined();
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["patterns/drums-verse.json"]]);
  });

  it("treats a document the snapshot does not name as removed", async () => {
    // Deleted while this window was disconnected, so nothing ever told it. In a diff
    // this would be a desync — the test above in "refusing to guess" holds that — but
    // a full snapshot's inventory is the authority on what exists.
    const sink = new RecordingSink();
    const store = open(sink);
    expect(store.getState().project!.automation.has("pad")).toBe(true);

    const disk = diskOf(store);
    delete disk["automation/pad.json"];
    store.getState().applyExternalChange(fullSnapshot(disk));

    const state = store.getState();
    expect(state.project!.automation.has("pad")).toBe(false);
    expect(state.canonical.has("automation/pad.json")).toBe(false);
    expect(state.lastExternalEdit?.removed).toEqual(["automation/pad.json"]);
    expect(state.outOfSync).toBeUndefined();
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("does nothing at all when the window was in step after all", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().setProjectName("Typed while offline");
    const revision = store.getState().revision;

    store.getState().applyExternalChange(fullSnapshot(diskOf(store)));

    // Every byte in it is a byte this window already had, so there is nothing to
    // adopt and — the property that matters — nothing to discard.
    expect(store.getState().revision).toBe(revision);
    expect(store.getState().project!.project.name).toBe("Typed while offline");
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(store.getState().lastExternalEdit).toBeUndefined();
  });

  it("still refuses a full snapshot it cannot account for", async () => {
    const store = open(new RecordingSink());
    const before = store.getState().project;
    const snapshot = fullSnapshot({ ...diskOf(store), "project.json": renamed(store, "Something moved") });

    // A document named in the inventory whose bytes the snapshot did not carry. A
    // full snapshot that is not actually full is not something to adopt half of:
    // the model would be built from a disk state nobody validated.
    store.getState().applyExternalChange({
      ...snapshot,
      files: [...snapshot.files, { path: "patterns/appeared.json", contentHash: "abc-1" }],
    });

    expect(store.getState().outOfSync).toContain("patterns/appeared.json");
    expect(store.getState().project).toBe(before);
  });
});

describe("local documents the disk has never seen", () => {
  /**
   * The asymmetry these cover: `canonical` is the model, which may hold a file
   * that has never been written and may have dropped one that is still on disk.
   * Only `onDisk` says what this window believes the disk holds, so only `onDisk`
   * may be compared against a snapshot's inventory. A file the server has never
   * seen is not a file the server deleted.
   */
  it("keeps a lane created while the socket was down, and does not call it an agent deletion", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    // Created in this window while the socket was down: it is in the model, it is
    // dirty, and it has never been on disk.
    store.getState().addAutomationLane("bass", "filter.cutoff");
    expect(store.getState().dirty).toEqual(["automation/bass.json"]);

    // The socket reconnects. The sidecar sends the disk it just read, which cannot
    // name a document this window has never written.
    store
      .getState()
      .applyExternalChange(fullSnapshot({ ...diskOf(store), "project.json": renamed(store, "Renamed offline") }));

    const state = store.getState();
    expect(state.project!.project.name).toBe("Renamed offline");
    expect(state.project!.automation.get("bass")?.lanes.map((lane) => lane.param)).toEqual(["filter.cutoff"]);
    expect(state.canonical.has("automation/bass.json")).toBe(true);
    // The property that matters: still unwritten, so still owed a write.
    expect(state.dirty).toEqual(["automation/bass.json"]);
    expect(state.lastExternalEdit?.removed).toEqual([]);
    expect(state.lastExternalEdit?.discarded).toEqual([]);
    expect(state.outOfSync).toBeUndefined();
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["automation/bass.json"]]);
  });

  it("adopts a diff that arrives while a locally created document is unwritten", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    store.getState().addAutomationLane("bass", "filter.cutoff");

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Theirs") }));

    const state = store.getState();
    expect(state.outOfSync).toBeUndefined();
    expect(state.project!.project.name).toBe("Theirs");
    expect(state.project!.automation.has("bass")).toBe(true);
    expect(state.dirty).toEqual(["automation/bass.json"]);
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["automation/bass.json"]]);
  });

  it("adopts a diff that arrives while a locally dropped document is still on disk", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    // The last lane of `automation/pad.json`, so the model drops the whole file;
    // the deletion has not reached disk yet.
    store.getState().removeAutomationLane("pad", "filter.cutoff");
    expect(store.getState().removing).toEqual(["automation/pad.json"]);

    store.getState().applyExternalChange(externalChange(store, { "project.json": renamed(store, "Theirs") }));

    const state = store.getState();
    expect(state.outOfSync).toBeUndefined();
    expect(state.project!.project.name).toBe("Theirs");
    expect(state.project!.automation.has("pad")).toBe(false);
    expect(state.removing).toEqual(["automation/pad.json"]);
    await store.getState().flushNow();
    expect(sink.deletedPaths).toEqual([["automation/pad.json"]]);
  });

  it("says so when the agent rewrites a document this window had dropped", () => {
    const store = open(new RecordingSink());
    store.getState().removeAutomationLane("pad", "filter.cutoff");
    const agentText = diskEdit(store, "automation/pad.json", '"interp": "linear"', '"interp": "step"');

    store.getState().applyExternalChange(externalChange(store, { "automation/pad.json": agentText }));

    const state = store.getState();
    // Last-writer-wins: the agent wrote the file, so it comes back — and the local
    // deletion that lost has to be named, or the file silently reappears.
    expect(state.outOfSync).toBeUndefined();
    expect(state.project!.automation.get("pad")?.lanes[0]?.interp).toBe("step");
    expect(state.lastExternalEdit?.discarded).toEqual(["automation/pad.json"]);
    expect(state.removing).toEqual([]);
  });

  it("still removes a locally dropped document the disk has also lost", () => {
    const store = open(new RecordingSink());
    store.getState().removeAutomationLane("pad", "filter.cutoff");

    const disk = diskOf(store);
    delete disk["automation/pad.json"];
    store.getState().applyExternalChange(fullSnapshot(disk));

    const state = store.getState();
    expect(state.outOfSync).toBeUndefined();
    expect(state.project!.automation.has("pad")).toBe(false);
    // Nothing left to delete: the disk agrees, so the write batch has no work.
    expect(state.removing).toEqual([]);
    expect(state.onDisk.has("automation/pad.json")).toBe(false);
  });
});
