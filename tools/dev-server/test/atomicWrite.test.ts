import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalFiles, loadProject, serializeCanonical } from "@chord-garden/format";
import { couldBeDocument, couldBeSample } from "../src/watch.js";
import { hashOnDisk, writeBatch } from "../src/write.js";

/**
 * Atomic writes (PLAN.md §10, §18: "not optional").
 *
 * The reason they are not optional is a crash: a document written in place is
 * observable half-written, so a sidecar killed mid-`write` can leave a project
 * file that is neither the old document nor the new one, and a strict-JSON format
 * has no way to read that back. Replacing the whole file by rename makes that
 * state unreachable rather than unlikely.
 *
 * The whole suite used to pass with `writeFileAtomically` replaced by a truncating
 * `writeFileSync`, so none of it was actually testing this. What follows asserts
 * the parts of the property that *are* observable from a single process:
 *
 * - a reader that opened the document before the write still reads the whole
 *   previous document, which is the observable form of "no partial content is ever
 *   visible at this path";
 * - the destination is *replaced* rather than written through, which is the thing
 *   that makes the above true for every reader rather than only for this one;
 * - the temporary file is inside the project, is a name the watcher ignores, and is
 *   gone afterwards;
 * - a write that cannot create its temporary file leaves the previous document
 *   exactly as it was.
 *
 * What is *not* observable here, and is stated rather than faked: this process
 * cannot be killed between the `writeSync` and the `rename` and then asked what is
 * on disk, so the crash itself is not exercised — only the property that makes the
 * crash safe. Nor is the `fsync` observable: whether the bytes reached the platter
 * before the rename is invisible to any reader on the same machine, and asserting
 * that `fsyncSync` was *called* would be asserting the implementation back to
 * itself.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const DOCUMENT = "patterns/drums-verse.json";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chord-garden-atomic-"));
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Canonical bytes for one of the project's documents, as the UI would send. */
function canonical(path: string): string {
  const result = loadProject(root);
  if (result.project === undefined) throw new Error(`fixture copy does not load: ${JSON.stringify(result.diagnostics)}`);
  const bytes = canonicalFiles(result.project).get(path);
  if (bytes === undefined) throw new Error(`no canonical bytes for ${path}`);
  return bytes;
}

/** A renamed copy of project.json, which is a legitimate edit. */
function renamedProject(name: string): string {
  const result = loadProject(root);
  const doc = structuredClone(result.project!.project);
  doc.name = name;
  return serializeCanonical(doc as never, "project");
}

/** An edit to the drum pattern, in canonical bytes. */
function editedPattern(): string {
  return canonical(DOCUMENT).replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx");
}

/** One file's worth of write batch, with the precondition the UI would send. */
function write(path: string, contents: string): void {
  const result = writeBatch(root, [{ path, contents, expectedHash: hashOnDisk(join(root, path)) }]);
  if (!result.ok) throw new Error(`write refused: ${result.status} ${result.message}`);
}

describe("atomic document writes", () => {
  it("leaves a reader that opened the document before the write holding the whole previous document", () => {
    const target = join(root, DOCUMENT);
    const before = readFileSync(target, "utf8");
    const after = editedPattern();
    expect(after).not.toBe(before);

    // A reader that has the file open across the write — the watcher's own load, a
    // `musictool validate` running alongside the UI, an agent's editor. Because the
    // write lands by replacing the directory entry, this descriptor still refers to
    // the *old* document, whole, for as long as it is held. There is no instant at
    // which it refers to a mixture, which is the property a crash mid-write depends
    // on and the one a truncating in-place write destroys.
    const held = openSync(target, "r");
    try {
      write(DOCUMENT, after);
      expect(readFileSync(held, "utf8")).toBe(before);
    } finally {
      closeSync(held);
    }
    expect(readFileSync(target, "utf8")).toBe(after);
  });

  it("replaces the document rather than writing through it", () => {
    const target = join(root, DOCUMENT);
    const inodeBefore = statSync(target).ino;

    write(DOCUMENT, editedPattern());

    // A different inode is what "replaced" means on a POSIX filesystem, and it is
    // the single fact that makes every reader's view atomic rather than only the
    // one this test happens to hold open. A truncating write keeps the inode and
    // mutates it under everybody.
    expect(statSync(target).ino).not.toBe(inodeBefore);
  });

  it("leaves no temporary file behind, in the project root or in a document directory", () => {
    const rootBefore = readdirSync(root).sort();
    const patternsBefore = readdirSync(join(root, "patterns")).sort();

    write(DOCUMENT, editedPattern());
    write("project.json", renamedProject("Two directories"));

    // `readdir` rather than a glob for `.tmp`: what matters is that the directory
    // is exactly as it was, including that nothing dotted was left lying about for
    // the loader to trip over.
    expect(readdirSync(root).sort()).toEqual(rootBefore);
    expect(readdirSync(join(root, "patterns")).sort()).toEqual(patternsBefore);
  });

  it("writes through a temporary file beside the document, named so the watcher ignores it", () => {
    // The temp name is built from the pid, the clock and `Math.random`, so pinning
    // the last two makes it predictable — which is what lets this test observe the
    // temp file at all without reaching into the module. Restored immediately: a
    // frozen clock is not something to leave running under the rest of the file.
    const target = join(root, DOCUMENT);
    const before = readFileSync(target, "utf8");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const temp = join(
      dirname(target),
      `.${basename(target)}.${process.pid}-${(1_700_000_000_000).toString(36)}-${(0.5).toString(36).slice(2, 8)}.tmp`,
    );

    // Inside the project and beside the document, so the rename cannot cross a
    // filesystem — a temp file in the OS temp directory would make `rename` a copy
    // on some systems and stop being atomic without any visible change.
    expect(dirname(temp)).toBe(dirname(target));
    // And a name neither half of the watcher's filter will look at, so the sidecar
    // does not scan the project because of its own scratch file.
    const relative = `patterns/${basename(temp)}`;
    expect(couldBeDocument(relative)).toBe(false);
    expect(couldBeSample(`samples/${basename(temp)}`)).toBe(false);

    // Occupying that exact path is the only way, from here, to prove the write goes
    // through it: the write cannot create it, so it fails — and an implementation
    // that wrote straight to the document would not care about this path at all and
    // would succeed.
    writeFileSync(temp, "in the way", "utf8");
    expect(() => write(DOCUMENT, editedPattern())).toThrow(/EEXIST/);

    // The document is untouched, which is the other half of the requirement: a
    // write that could not complete must leave the previous bytes exactly as they
    // were rather than a truncated file.
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(temp)).toBe(false);
  });
});
