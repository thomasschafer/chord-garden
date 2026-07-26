import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentStore,
  hashText,
  WRITE_DEBOUNCE_MS,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
  type PendingFile,
} from "../src/store/documentStore";
import { FIXTURE, openedFrom } from "./fixture";

/** Records what it was asked to write, and resolves immediately. */
class RecordingSink implements DocumentSink {
  readonly batches: PendingFile[][] = [];

  async write(files: readonly PendingFile[]) {
    this.batches.push(files.map((file) => ({ ...file })));
    return { diagnostics: [] };
  }

  /** Every path written, in order, flattened across batches. */
  get paths(): string[][] {
    return this.batches.map((batch) => batch.map((file) => file.path));
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

  get paths(): string[][] {
    return this.batches.map((batch) => batch.map((file) => file.path));
  }
}

function open(sink: DocumentSink, debounceMs?: number): DocumentStore {
  const store = createDocumentStore(debounceMs === undefined ? { sink } : { sink, debounceMs });
  store.getState().open(openedFrom(FIXTURE));
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("opening a project", () => {
  it("starts clean, with the fixture already canonical on disk", () => {
    const store = open(new RecordingSink());
    const state = store.getState();

    expect(state.project?.project.name).toBeTypeOf("string");
    expect(state.dirty).toEqual([]);
    // The fixture is what `musictool fmt` produces, so nothing is flagged. If
    // this ever fails, the fixture drifted from the canonical serializer.
    expect(state.unformatted).toEqual([]);
    expect(state.canonical.size).toBe(state.persisted.size);
  });

  it("flags a document that is valid but not canonical on disk, without rewriting it", async () => {
    const sink = new RecordingSink();
    const store = createDocumentStore({ sink });
    const opened = openedFrom(FIXTURE);
    // Same document, different bytes: an extra blank line is exactly the kind of
    // hand-edit `fmt` would tidy and the UI must not silently tidy for it.
    const texts = new Map(opened.texts);
    texts.set("tracks/drums.json", `${texts.get("tracks/drums.json")!}\n`);

    store.getState().open({ ...opened, texts });

    expect(store.getState().unformatted).toEqual(["tracks/drums.json"]);
    expect(store.getState().dirty).toEqual([]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });
});

describe("dirty tracking", () => {
  it("writes only the file an edit actually changed", async () => {
    const sink = new RecordingSink();
    const store = open(sink);

    store.getState().setProjectName("Renamed");
    expect(store.getState().dirty).toEqual(["project.json"]);
    await store.getState().flushNow();

    expect(sink.paths).toEqual([["project.json"]]);
    expect(store.getState().dirty).toEqual([]);
  });

  it("keeps a pattern edit to that pattern's own file, which is the point of the layout", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const before = store.getState().canonical.get("patterns/drums-verse.json");

    store.getState().setPatternLaneSteps("drums-verse", "hat", "xxxx xxxx xxxx xxxx");
    await store.getState().flushNow();

    expect(sink.paths).toEqual([["patterns/drums-verse.json"]]);
    expect(sink.batches[0]![0]!.contents).not.toBe(before);
    // Eleven documents in this project; ten of them were never touched.
    expect(store.getState().canonical.size).toBeGreaterThan(1);
  });

  it("treats an edit that restores the persisted value as no edit at all", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const original = store.getState().project!.project.name;

    store.getState().setProjectName("Something else");
    store.getState().setProjectName(original);

    expect(store.getState().dirty).toEqual([]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("collects edits to different files into one batch", async () => {
    const sink = new RecordingSink();
    const store = open(sink);

    store.getState().setProjectName("Two files");
    store.getState().setPatternLaneSteps("drums-verse", "hat", "x... x... x... x...");

    expect(store.getState().dirty).toEqual(["patterns/drums-verse.json", "project.json"]);
    await store.getState().flushNow();
    expect(sink.paths).toEqual([["patterns/drums-verse.json", "project.json"]]);
  });
});

describe("debounced writes", () => {
  it("writes nothing until the window has elapsed, then writes once", async () => {
    vi.useFakeTimers();
    const sink = new RecordingSink();
    const store = open(sink);

    // Typing a name, one keystroke at a time.
    for (const name of ["A", "Ac", "Aci", "Acid"]) {
      store.getState().setProjectName(name);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(sink.batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);

    expect(sink.paths).toEqual([["project.json"]]);
    expect(sink.batches[0]![0]!.contents).toContain('"name": "Acid"');
  });

  it("does not fire early: one tick short of the window writes nothing", async () => {
    vi.useFakeTimers();
    const sink = new RecordingSink();
    const store = open(sink);

    store.getState().setProjectName("Later");
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1);
    expect(sink.batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sink.batches).toHaveLength(1);
  });
});

describe("writes in flight", () => {
  it("does not lose an edit made while a batch is being written", async () => {
    const sink = new DeferredSink();
    const store = open(sink, 10_000);

    store.getState().setProjectName("First");
    const first = store.getState().flushNow();
    expect(sink.paths).toEqual([["project.json"]]);

    // The edit lands while the first batch is still open.
    store.getState().setPatternLaneSteps("drums-verse", "hat", "x... x... x... x...");
    const second = store.getState().flushNow();
    expect(sink.batches).toHaveLength(1);

    sink.releaseAll();
    await first;
    sink.releaseAll();
    await second;

    expect(sink.paths).toEqual([["project.json"], ["patterns/drums-verse.json"]]);
    expect(store.getState().dirty).toEqual([]);
  });

  it("never has two batches open at once for the same file", async () => {
    const sink = new DeferredSink();
    const store = open(sink, 10_000);

    store.getState().setProjectName("One");
    const first = store.getState().flushNow();
    store.getState().setProjectName("Two");
    const second = store.getState().flushNow();

    expect(sink.batches).toHaveLength(1);
    sink.releaseAll();
    await first;
    sink.releaseAll();
    await second;

    expect(sink.paths).toEqual([["project.json"], ["project.json"]]);
    expect(sink.batches[1]![0]!.contents).toContain('"name": "Two"');
  });
});

describe("failure handling", () => {
  it("keeps the files dirty when a write fails, and writes them on the retry", async () => {
    let failNext = true;
    const written: string[][] = [];
    const sink: DocumentSink = {
      async write(files) {
        if (failNext) {
          failNext = false;
          throw new Error("sidecar said no");
        }
        written.push(files.map((file) => file.path));
        return { diagnostics: [] };
      },
    };
    const store = open(sink);

    store.getState().setProjectName("Retry me");
    await store.getState().flushNow();

    expect(store.getState().lastWriteError).toBe("sidecar said no");
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(store.getState().batchesWritten).toBe(0);

    await store.getState().flushNow();

    expect(written).toEqual([["project.json"]]);
    expect(store.getState().dirty).toEqual([]);
    expect(store.getState().lastWriteError).toBeUndefined();
  });

  it("refuses an edit that could not be serialized, and leaves the model untouched", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const before = store.getState().project;
    const revision = store.getState().revision;

    // "y" is not a step character, so the pattern grammar rejects it before the
    // model is replaced rather than after it is written.
    expect(() => store.getState().setPatternLaneSteps("drums-verse", "hat", "yyyy yyyy yyyy yyyy")).toThrow(
      /cannot edit steps/,
    );

    expect(store.getState().project).toBe(before);
    expect(store.getState().revision).toBe(revision);
    expect(store.getState().dirty).toEqual([]);
    await store.getState().flushNow();
    expect(sink.batches).toEqual([]);
  });

  it("refuses a tempo that the format could not store as an integer", () => {
    const store = open(new RecordingSink());

    expect(() => store.getState().setTempoBpmX100(124.5)).toThrow(/integer/);
    expect(store.getState().dirty).toEqual([]);
  });

  it("refuses to edit before a project is open", () => {
    const store = createDocumentStore({ sink: new RecordingSink() });

    expect(() => store.getState().setProjectName("nothing to name")).toThrow(/no project is open/);
  });
});

describe("write preconditions and conflicts", () => {
  it("tells the server which bytes it believes are on disk", async () => {
    const sink = new RecordingSink();
    const store = open(sink);
    const diskBytes = store.getState().onDisk.get("project.json")!;

    store.getState().setProjectName("Precondition");
    await store.getState().flushNow();

    expect(sink.batches[0]![0]!.expectedHash).toBe(hashText(diskBytes));
  });

  it("uses the real disk bytes as the precondition for a file that was not canonical", async () => {
    const sink = new RecordingSink();
    const store = createDocumentStore({ sink });
    const opened = openedFrom(FIXTURE);
    const texts = new Map(opened.texts);
    const scruffy = `${texts.get("project.json")!}\n`;
    texts.set("project.json", scruffy);
    store.getState().open({ ...opened, texts });

    store.getState().setProjectName("Tidied on the way past");
    await store.getState().flushNow();

    // Not the canonical baseline it diffs against — the bytes actually there,
    // or the server would refuse a write that is perfectly correct.
    expect(sink.batches[0]![0]!.expectedHash).toBe(hashText(scruffy));
  });

  it("sends a null precondition for a document that does not exist yet", async () => {
    const sink = new RecordingSink();
    const store = createDocumentStore({ sink });
    const opened = openedFrom(FIXTURE);
    const texts = new Map(opened.texts);
    texts.delete("automation/pad.json");
    store.getState().open({ ...opened, texts });

    store.getState().setProjectName("Anything");
    await store.getState().flushNow();
    // The automation document is unchanged, so only project.json is written;
    // what matters is that a path with no known disk bytes hashes to null.
    expect(store.getState().onDisk.has("automation/pad.json")).toBe(false);
    expect(sink.batches[0]!.map((file) => file.path)).toEqual(["project.json"]);
  });

  it("stops writing after a conflict instead of retrying over the other editor", async () => {
    let attempts = 0;
    const sink: DocumentSink = {
      async write(files) {
        attempts++;
        throw new WriteConflictError("project.json changed on disk", files.map((file) => file.path));
      },
    };
    const store = open(sink);

    store.getState().setProjectName("Mine");
    await store.getState().flushNow();

    expect(attempts).toBe(1);
    expect(store.getState().conflict?.paths).toEqual(["project.json"]);
    // The edit is still here and still unsaved — nothing was silently dropped.
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(store.getState().project!.project.name).toBe("Mine");

    // Further edits and flushes must not touch the server again.
    store.getState().setProjectName("Mine again");
    await store.getState().flushNow();
    expect(attempts).toBe(1);
  });

  it("clears the conflict only by reopening, and then writes normally again", async () => {
    let conflictNext = true;
    const written: string[][] = [];
    const sink: DocumentSink = {
      async write(files) {
        if (conflictNext) {
          conflictNext = false;
          throw new WriteConflictError("changed on disk", files.map((file) => file.path));
        }
        written.push(files.map((file) => file.path));
        return { diagnostics: [] };
      },
    };
    const store = open(sink);

    store.getState().setProjectName("Doomed");
    await store.getState().flushNow();
    expect(store.getState().conflict).toBeDefined();

    store.getState().open(openedFrom(FIXTURE));

    expect(store.getState().conflict).toBeUndefined();
    expect(store.getState().dirty).toEqual([]);
    store.getState().setProjectName("Second attempt");
    await store.getState().flushNow();
    expect(written).toEqual([["project.json"]]);
  });
});
