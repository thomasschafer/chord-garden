import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { couldBeDocument, couldBeSample, DirectoryWatcher } from "../src/watch.js";

/**
 * When the watcher decides the dust has settled, on a clock the test owns.
 *
 * Every timing question about this class is answered here rather than in
 * `sync.test.ts`, and answered with a fake clock: "a burst of events becomes one
 * scan" and "an idle project is re-scanned anyway" are claims about elapsed time,
 * and the only way to test them honestly is to control time. A test that instead
 * slept and hoped would be the flaky one, and — worse — would still pass if the
 * coalescing were removed entirely.
 *
 * Nothing here touches a real file. The watcher is pointed at an empty temporary
 * directory and driven through `touch`, which is exactly what its `fs.watch`
 * subscription does with an event, so what is under test is the coalescing rather
 * than the operating system's opinion about when to report a write.
 */

const SETTLE_MS = 100;
const MAX_SETTLE_MS = 500;
const RESCAN_MS = 5_000;

let root: string;
let watcher: DirectoryWatcher | undefined;
let settles: number;
let errors: string[];

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "chord-garden-watch-"));
  settles = 0;
  errors = [];
});

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function start(options: { onSettle?: () => void } = {}): DirectoryWatcher {
  watcher = new DirectoryWatcher({
    root,
    settleMs: SETTLE_MS,
    maxSettleMs: MAX_SETTLE_MS,
    rescanMs: RESCAN_MS,
    onSettle:
      options.onSettle ??
      ((): void => {
        settles += 1;
      }),
    onError: (message) => errors.push(message),
  });
  return watcher;
}

describe("coalescing filesystem events", () => {
  it("turns a burst of events into exactly one settle", () => {
    const watch = start();

    // Four events, each just before the previous one would have settled, and the
    // whole burst inside `maxSettleMs` so the delay bound does not cut it short.
    for (let event = 0; event < 4; event++) {
      watch.touch("patterns/drums-verse.json");
      vi.advanceTimersByTime(SETTLE_MS - 1);
    }
    expect(settles).toBe(0);
    expect(watch.settling).toBe(true);

    vi.advanceTimersByTime(SETTLE_MS);

    expect(settles).toBe(1);
    expect(watch.settling).toBe(false);
  });

  it("scans a continuous stream of events at least every maxSettleMs", () => {
    // A `musictool render` writing into the project, or an agent rewriting a file
    // in a loop: without the bound, the settle timer is restarted forever and the
    // UI never hears anything at all.
    const watch = start();

    for (let elapsed = 0; elapsed < MAX_SETTLE_MS * 2; elapsed += SETTLE_MS / 2) {
      watch.touch("project.json");
      vi.advanceTimersByTime(SETTLE_MS / 2);
    }

    expect(settles).toBeGreaterThanOrEqual(1);
    expect(settles).toBeLessThanOrEqual(3);
  });

  it("reports an error from a settle rather than letting it escape", () => {
    const watch = start({
      onSettle: () => {
        throw new Error("the scan blew up");
      },
    });

    watch.touch("project.json");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(errors).toEqual(["the scan blew up"]);
  });

  it("does nothing after close, timers included", () => {
    const watch = start();
    watch.touch("project.json");

    watch.close();
    vi.advanceTimersByTime(RESCAN_MS * 4);

    expect(settles).toBe(0);
  });
});

describe("the idle re-scan", () => {
  it("scans an idle project even though no event ever arrives", () => {
    // The safety net for recursive `fs.watch`: emulated on Linux and missing some
    // newly created subdirectories, absent on network mounts. Without this the UI
    // silently stops following the disk; with it, a missed event costs one interval.
    start();

    vi.advanceTimersByTime(RESCAN_MS);
    expect(settles).toBe(1);

    vi.advanceTimersByTime(RESCAN_MS);
    expect(settles).toBe(2);
  });

  it("does not scan while a burst is still coalescing", () => {
    const watch = start();

    // An event arrives just before the re-scan would have fired. The burst owns the
    // next scan; a second one would read the disk twice for the same news.
    vi.advanceTimersByTime(RESCAN_MS - 1);
    watch.touch("project.json");
    vi.advanceTimersByTime(1);

    expect(settles).toBe(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(settles).toBe(1);
  });

  it("waits a full interval after a settle before scanning again", () => {
    const watch = start();

    watch.touch("project.json");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(settles).toBe(1);

    // The interval's own tick lands here, but the event-driven scan was recent, so
    // it is skipped rather than doubling up.
    vi.advanceTimersByTime(RESCAN_MS - SETTLE_MS);
    expect(settles).toBe(1);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(settles).toBe(2);
  });
});

describe("which names could be a document", () => {
  it("accepts the bundle layout and refuses everything else", () => {
    for (const name of ["project.json", "arrangement.json", "patterns/drums-verse.json", "tracks/bass.json"]) {
      expect(couldBeDocument(name), name).toBe(true);
    }
    for (const name of [
      "render/master.wav",
      "samples/kick.wav",
      "notes.txt",
      "patterns/.drums-verse.json.123.tmp",
      "patterns/nested/deep.json",
    ]) {
      expect(couldBeDocument(name), name).toBe(false);
    }
  });

  it("accepts a Windows-style separator, because a filter is not a place to be clever", () => {
    expect(couldBeDocument("patterns\\drums-verse.json")).toBe(true);
  });
});

describe("which names could be a sample", () => {
  it("accepts anything under samples/, at any depth", () => {
    for (const name of ["samples/kick.wav", "samples/kits/909/kick.wav", "samples\\kick.wav"]) {
      expect(couldBeSample(name), name).toBe(true);
    }
  });

  /**
   * Deliberately not restricted to `.wav`: the extension rule belongs to the
   * validator (docs/format-spec.md §8), and a kit voice pointed at a file this filter
   * had hidden would produce no diagnostic at all — the sound and the disk would
   * disagree with nothing said about it, which is the whole failure being closed.
   */
  it("accepts a non-wav file under samples/, so the validator can be the one to refuse it", () => {
    expect(couldBeSample("samples/kick.aiff")).toBe(true);
  });

  it("refuses everything outside samples/, and dotted names inside it", () => {
    for (const name of [
      "project.json",
      "patterns/drums-verse.json",
      "render/master.wav",
      "samples.wav",
      "samplesnaked/kick.wav",
      "samples/.hidden.wav",
      "samples/.kick.wav.123.tmp",
      "samples/kits/.tmp.wav",
    ]) {
      expect(couldBeSample(name), name).toBe(false);
    }
  });

  it("settles for a sample event, which is the filter this whole path hangs on", () => {
    // Until this, `samples/` was filtered out entirely and replacing a WAV reached
    // nothing: the render picked it up and a running app did not. A settle for the
    // name is the first link in the chain.
    const watch = start();

    watch.touch("samples/kick.wav");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(settles).toBe(1);
  });

  it("still does not settle for a render output or an editor temporary", () => {
    const watch = start();

    watch.touch("render/master.wav");
    watch.touch("samples/.kick.wav.99.tmp");
    vi.advanceTimersByTime(SETTLE_MS * 4);

    expect(settles).toBe(0);
  });
});
