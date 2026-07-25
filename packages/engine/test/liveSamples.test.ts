import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SampleStore, hashContent } from "../src/live/sampleCache.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));

describe("sample content hashing", () => {
  it("distinguishes different content and matches identical content", () => {
    const kick = readFileSync(join(FIXTURE, "samples/kick.wav"));
    const hat = readFileSync(join(FIXTURE, "samples/hat.wav"));
    expect(hashContent(kick)).toBe(hashContent(readFileSync(join(FIXTURE, "samples/kick.wav"))));
    expect(hashContent(kick)).not.toBe(hashContent(hat));
  });

  it("notices a single flipped byte and a change in length", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const flipped = new Uint8Array(bytes);
    flipped[5] = 9;
    expect(hashContent(bytes)).not.toBe(hashContent(flipped));
    // A hash over content alone can collide on a prefix; the length is mixed in.
    expect(hashContent(bytes)).not.toBe(hashContent(bytes.subarray(0, 7)));
    expect(hashContent(new Uint8Array(0))).toBe(hashContent(new Uint8Array(0)));
  });

  it("hashes the bytes, not the view, so an offset view of the same bytes agrees", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3]);
    expect(hashContent(backing.subarray(2))).toBe(hashContent(new Uint8Array([1, 2, 3])));
  });
});

describe("sample store", () => {
  it("serves content by path and reports what a path holds", () => {
    const store = new SampleStore<string>();
    expect(store.needsUpdate("samples/kick.wav", "aaa")).toBe(true);
    store.set("samples/kick.wav", "aaa", () => "kick-v1");
    expect(store.get("samples/kick.wav")).toBe("kick-v1");
    expect(store.hashOf("samples/kick.wav")).toBe("aaa");
    expect(store.needsUpdate("samples/kick.wav", "aaa")).toBe(false);
  });

  /** PLAN.md §14: replacing a sample file must invalidate, and by content. */
  it("replaces a path's content when its hash changes and drops the old decode", () => {
    const store = new SampleStore<string>();
    store.set("samples/kick.wav", "aaa", () => "kick-v1");
    expect(store.contentCount).toBe(1);

    expect(store.needsUpdate("samples/kick.wav", "bbb")).toBe(true);
    store.set("samples/kick.wav", "bbb", () => "kick-v2");
    expect(store.get("samples/kick.wav")).toBe("kick-v2");
    expect(store.getByHash("aaa")).toBeUndefined();
    expect(store.contentCount).toBe(1);
    expect(store.pathCount).toBe(1);
  });

  it("does not re-decode content it already holds under another path", () => {
    const store = new SampleStore<string>();
    let decodes = 0;
    const decode = (): string => {
      decodes++;
      return "shared";
    };
    store.set("samples/kick.wav", "aaa", decode);
    store.set("samples/kick-copy.wav", "aaa", decode);
    expect(decodes).toBe(1);
    expect(store.get("samples/kick-copy.wav")).toBe("shared");
    expect(store.contentCount).toBe(1);
    expect(store.pathCount).toBe(2);
  });

  it("keeps shared content alive until the last path referring to it is gone", () => {
    const store = new SampleStore<string>();
    store.set("a.wav", "aaa", () => "shared");
    store.set("b.wav", "aaa", () => "shared");
    store.invalidate("a.wav");
    expect(store.get("b.wav")).toBe("shared");
    expect(store.contentCount).toBe(1);
    store.invalidate("b.wav");
    expect(store.contentCount).toBe(0);
    expect(store.get("b.wav")).toBeUndefined();
  });

  it("re-setting the same content for the same path is free and does not re-decode", () => {
    const store = new SampleStore<string>();
    let decodes = 0;
    store.set("a.wav", "aaa", () => {
      decodes++;
      return "v1";
    });
    store.set("a.wav", "aaa", () => {
      decodes++;
      return "v2";
    });
    expect(decodes).toBe(1);
    expect(store.get("a.wav")).toBe("v1");
  });

  it("ignores invalidating a path it never held", () => {
    const store = new SampleStore<string>();
    expect(() => store.invalidate("missing.wav")).not.toThrow();
    expect(store.pathCount).toBe(0);
  });
});
