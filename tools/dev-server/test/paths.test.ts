import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveProjectAsset } from "../src/paths.js";

/**
 * A project directory with the two things confinement has to survive: a file
 * outside it, and a symlink inside it pointing at that file.
 */
let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "chord-garden-paths-"));
  root = join(base, "project");
  mkdirSync(join(root, "samples"), { recursive: true });
  writeFileSync(join(root, "project.json"), "{}");
  writeFileSync(join(root, "samples", "kick.wav"), "RIFF");
  writeFileSync(join(root, "notes.md"), "not a project document");
  outside = join(base, "secret.json");
  writeFileSync(outside, '{"secret":true}');
  symlinkSync(outside, join(root, "escape.json"));
  symlinkSync(join(root, "project.json"), join(root, "samples", "inside.json"));
});

function reject(requested: string): { status: number; message: string } {
  const result = resolveProjectAsset(root, requested);
  if (result.ok) throw new Error(`expected "${requested}" to be refused, got ${result.path}`);
  return { status: result.status, message: result.message };
}

describe("project asset confinement", () => {
  it("resolves documents and samples inside the project", () => {
    const document = resolveProjectAsset(root, "project.json");
    expect(document).toMatchObject({ ok: true, contentType: "application/json; charset=utf-8" });
    const sample = resolveProjectAsset(root, "samples/kick.wav");
    expect(sample).toMatchObject({ ok: true, contentType: "audio/wav" });
  });

  it("follows a symlink that stays inside the project", () => {
    expect(resolveProjectAsset(root, "samples/inside.json").ok).toBe(true);
  });

  it("refuses every spelling of a path that leaves the project", () => {
    for (const attempt of [
      "../secret.json",
      "samples/../../secret.json",
      "..%2Fsecret.json",
      "%2e%2e/secret.json",
      "/etc/passwd",
      "samples//../../secret.json",
      "./project.json",
    ]) {
      expect(reject(attempt).status, attempt).toBe(403);
    }
  });

  it("refuses a symlink that leaves the project even though it resolves", () => {
    const refusal = reject("escape.json");
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain("leaves the project root");
  });

  it("refuses NUL bytes, control characters and backslashes", () => {
    expect(reject("project.json%00.wav").status).toBe(400);
    expect(reject("samples%5C..%5Csecret.json").status).toBe(400);
    expect(reject("pro%0aject.json").status).toBe(400);
  });

  it("refuses malformed percent-encoding rather than guessing", () => {
    expect(reject("%zz.json").status).toBe(400);
  });

  it("serves only project document and sample extensions", () => {
    expect(reject("notes.md").status).toBe(403);
    expect(reject("notes.md").message).toContain("not a servable project file");
  });

  it("reports a missing file as missing and a directory as not a file", () => {
    expect(reject("absent.json").status).toBe(404);
    expect(reject("samples").status).toBe(403);
  });

  it("refuses an empty path", () => {
    expect(reject("").status).toBe(400);
  });
});
