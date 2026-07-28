import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN.md §12, trap two: **decide identity on full bytes, not on the hash.**
 *
 * The content hash is right for write preconditions and for telling the browser
 * what changed. It is wrong for deciding *whether* a file changed, because a
 * collision there does not produce a wrong hash somewhere harmless — it produces
 * "these bytes are the ones we established", which is the sidecar's word for "this
 * is our own echo, ignore it". The agent's edit is then never announced, never
 * adopted, and is overwritten by the UI's next write. Nothing anywhere reports it.
 *
 * A real FNV collision cannot be manufactured cheaply — and this one is harder than
 * §12's "64-bit" suggests, because `hashContent` appends the byte length, so a
 * colliding pair must also be the same length. So the collision is injected instead,
 * at the module boundary the sidecar already imports it through: `hashContent` is
 * replaced by one that returns a single digest for the two specific byte strings
 * this test nominates and the real digest for everything else. That is a *targeted*
 * collision rather than a degenerate hash — the rest of the project, and the sample
 * inventory, keep hashing normally — so what is under test is exactly the identity
 * decision and not the sidecar's behaviour under a broken hash generally.
 *
 * No production code changes shape for this. If the decision is `established !==
 * text`, the injected collision is invisible to it and the edit is announced; if it
 * is ever rewritten to compare digests, it silently eats the edit and this fails.
 */

/**
 * Byte strings this test declares to collide. Hoisted because `vi.mock` is lifted
 * above the imports and the factory closes over it.
 */
const colliding = vi.hoisted(() => new Set<string>());

vi.mock("@chord-garden/engine/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chord-garden/engine/live")>();
  return {
    ...actual,
    hashContent: (bytes: ArrayBufferView): string => {
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
      return colliding.has(text) ? "cccccccccccccccc-collision" : actual.hashContent(bytes);
    },
  };
});

const { hashContent } = await import("@chord-garden/engine/live");
const { ProjectSync } = await import("../src/sync.js");

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const DOCUMENT = "patterns/drums-verse.json";
const TOKEN = "identity-token-0123456789abcdef";

let root: string;
let lines: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chord-garden-identity-"));
  cpSync(FIXTURE, root, { recursive: true });
  lines = [];
  colliding.clear();
});

afterEach(() => {
  colliding.clear();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A sidecar whose scans this test drives itself. No watcher: what is under test is
 * what a scan concludes, not when the OS decides one should happen.
 */
function sidecar(): InstanceType<typeof ProjectSync> {
  return new ProjectSync({
    mount: { name: "p", root },
    token: TOKEN,
    watchFilesystem: false,
    log: (line) => lines.push(line),
  });
}

describe("echo identity is decided on bytes, not on the content hash", () => {
  it("still reports an external edit whose bytes hash to what the sidecar established", () => {
    const target = join(root, DOCUMENT);
    const before = readFileSync(target, "utf8");
    const after = before.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx");
    expect(after).not.toBe(before);

    // Nominate the two as a colliding pair, and check the injection really took —
    // without this the test could quietly stop testing anything if the module id or
    // the mock ever changed, and would still pass.
    colliding.add(before);
    colliding.add(after);
    const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
    expect(hashContent(bytes(after))).toBe(hashContent(bytes(before)));
    expect(bytes(after).byteLength).toBe(bytes(before).byteLength);

    const sync = sidecar();
    try {
      expect(sync.establishedText(DOCUMENT)).toBe(before);

      // The agent's edit. Every byte of it differs from what was established; only
      // the digests agree.
      writeFileSync(target, after, "utf8");
      sync.scan();

      // Adopted, so the browser was sent it and the sidecar's baseline moved. A
      // digest-based identity concludes "our own echo" here and returns before this
      // line, leaving the sidecar holding bytes that are not on disk and the edit
      // announced to nobody.
      expect(sync.establishedText(DOCUMENT)).toBe(after);
      expect(lines.some((line) => line.includes("external edit") && line.includes(DOCUMENT))).toBe(true);
    } finally {
      sync.close();
    }
  });

  it("still says nothing about a rewrite that really is byte-identical", () => {
    // The control. Without it the test above would pass just as well against a
    // sidecar that announced every scan, which is the other way to lose this
    // property — and the one that produces a reconcile storm rather than a lost
    // edit (PLAN.md §12, trap three).
    const target = join(root, DOCUMENT);
    const before = readFileSync(target, "utf8");
    colliding.add(before);

    const sync = sidecar();
    try {
      writeFileSync(target, before, "utf8");
      sync.scan();

      expect(lines.filter((line) => line.includes("external edit"))).toEqual([]);
      expect(sync.establishedText(DOCUMENT)).toBe(before);
    } finally {
      sync.close();
    }
  });
});
