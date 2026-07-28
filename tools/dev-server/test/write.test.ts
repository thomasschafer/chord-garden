import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalFiles, loadProject, serializeCanonical } from "@chord-garden/format";
import type { WriteResponse } from "../src/api.js";
import { createAssetServer } from "../src/server.js";
import { MAX_BODY_BYTES, hashOnDisk } from "../src/write.js";
import { rawRequest } from "./helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const TOKEN = "write-token-0123456789abcdef";

let server: Server;
let port: number;
let root: string;
let origin: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "chord-garden-write-"));
  cpSync(FIXTURE, root, { recursive: true });
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
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

function post(body: string, options: { token?: string | undefined; origin?: string | undefined; path?: string } = {}) {
  return rawRequest(port, options.path ?? "/api/projects/p/write", {
    method: "POST",
    body,
    ...("token" in options ? { token: options.token } : { token: TOKEN }),
    ...("origin" in options ? { origin: options.origin } : { origin }),
  });
}

/** The hash the server will compute for a file right now, i.e. a matching precondition. */
function diskHash(relative: string): string | null {
  return hashOnDisk(join(root, relative));
}

function batch(path: string, contents: string, expectedHash: string | null = diskHash(path)): string {
  return JSON.stringify({ files: [{ path, contents, expectedHash }] });
}

describe("write endpoint authentication", () => {
  it("refuses a write with no session token", async () => {
    const response = await post(batch("project.json", renamedProject("nope")), { token: undefined });
    expect(response.status).toBe(401);
    expect(loadProject(root).project!.project.name).not.toBe("nope");
  });

  it("refuses a write with the wrong session token", async () => {
    const response = await post(batch("project.json", renamedProject("nope")), { token: `${TOKEN}x` });
    expect(response.status).toBe(401);
  });

  it("refuses a read with no session token, so the whole api is behind it", async () => {
    expect((await rawRequest(port, "/api/projects")).status).toBe(401);
    expect((await rawRequest(port, "/api/projects/p")).status).toBe(401);
    expect((await rawRequest(port, "/api/projects/p/files/project.json")).status).toBe(401);
  });

  it("still serves the pages unauthenticated, and hands them the token", async () => {
    const page = await rawRequest(port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain(TOKEN);
  });
});

describe("write endpoint origin and host checks", () => {
  it("refuses a write that carries no Origin, as a non-browser caller would", async () => {
    const response = await post(batch("project.json", renamedProject("nope")), { origin: undefined });
    expect(response.status).toBe(403);
    expect(response.body).toContain("Origin");
  });

  it("refuses a write from another origin", async () => {
    for (const forged of ["http://evil.example.com", "https://localhost", `http://localhost:${port + 1}`, "null"]) {
      const response = await post(batch("project.json", renamedProject("nope")), { origin: forged });
      expect(response.status, forged).toBe(403);
    }
  });

  it("refuses a write addressed to a non-loopback host name", async () => {
    const response = await rawRequest(port, "/api/projects/p/write", {
      method: "POST",
      body: batch("project.json", renamedProject("nope")),
      token: TOKEN,
      host: "attacker.example.com",
      origin: "http://attacker.example.com",
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("loopback-only");
  });

  it("takes GET and HEAD off the write route rather than treating them as writes", async () => {
    const response = await rawRequest(port, "/api/projects/p/write", { token: TOKEN });
    expect(response.status).toBe(405);
  });
});

describe("write endpoint path confinement", () => {
  it("refuses every way of naming a file outside the project root", async () => {
    const outside = join(root, "..", "escaped.json");
    for (const path of [
      "../escaped.json",
      "..%2Fescaped.json",
      "%2e%2e%2fescaped.json",
      "/etc/passwd",
      "tracks/../../escaped.json",
      "./project.json",
      "tracks/./drums.json",
    ]) {
      const response = await post(batch(path, renamedProject("nope")));
      expect(response.status, path).toBe(403);
    }
    expect(() => readFileSync(outside, "utf8")).toThrow();
  });

  it("refuses paths that are inside the root but not project documents", async () => {
    for (const path of [
      "samples/kick.wav",
      "notes.txt",
      "render/master.wav",
      "secrets.json",
      "tracks/drums.txt",
      "tracks/nested/drums.json",
      "tracks/Drums.json",
      "tracks/-drums.json",
    ]) {
      const response = await post(batch(path, renamedProject("nope")));
      expect(response.status, path).toBe(403);
    }
  });

  it("refuses a write through a symlinked document that points out of the root", async () => {
    const payload = renamedProject("nope");
    const outside = join(root, "..", `outside-${Date.now()}.json`);
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(root, "tracks", "escape.json"));

    const response = await post(batch("tracks/escape.json", payload));

    expect(response.status).toBe(403);
    expect(readFileSync(outside, "utf8")).toBe("{}\n");
    rmSync(outside, { force: true });
  });

  it("refuses a write through a symlinked document directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "chord-garden-outside-"));
    rmSync(join(root, "automation"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "automation"));

    const response = await post(batch("automation/pad.json", renamedProject("nope")));

    expect(response.status).toBe(403);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("write endpoint content rules", () => {
  it("refuses bytes that are valid JSON but not canonical", async () => {
    const project = loadProject(root).project!;
    const naive = `${JSON.stringify(project.project, null, 2)}\n`;
    const before = readFileSync(join(root, "project.json"), "utf8");

    const response = await post(batch("project.json", naive));

    expect(response.status).toBe(422);
    expect(response.body).toContain("canonical");
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(before);
  });

  it("refuses a document with a comment in it, the way the loader would", async () => {
    const withComment = `// a note to self\n${canonical("project.json")}`;
    const response = await post(batch("project.json", withComment));
    expect(response.status).toBe(422);
  });

  it("refuses a batch naming the same file twice", async () => {
    const body = JSON.stringify({
      files: [
        { path: "project.json", contents: renamedProject("one"), expectedHash: diskHash("project.json") },
        { path: "project.json", contents: renamedProject("two"), expectedHash: diskHash("project.json") },
      ],
    });
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(loadProject(root).project!.project.name).not.toBe("two");
  });

  it("refuses a body over the size limit without writing anything, and stays responsive", async () => {
    const before = readFileSync(join(root, "project.json"), "utf8");

    const response = await post(
      JSON.stringify({ files: [{ path: "project.json", contents: "x".repeat(MAX_BODY_BYTES), expectedHash: null }] }),
    );

    // The 413 is deliverable because the server drains an over-limit body before
    // answering; answering first would race the client's remaining writes and
    // surface as ECONNRESET under load rather than as a status. See `readBody`.
    expect(response.status).toBe(413);
    expect(response.body).toContain(String(MAX_BODY_BYTES));
    // The two properties that hold regardless of how the connection ends: the
    // refusal changed nothing, and draining did not wedge the server.
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(before);
    expect((await rawRequest(port, "/api/projects/p", { token: TOKEN })).status).toBe(200);
  });

  it("refuses a batch with more files than a project could have", async () => {
    const files = Array.from({ length: 65 }, (_, index) => ({
      path: `tracks/t${index}.json`,
      contents: canonical("tracks/drums.json"),
      expectedHash: null,
    }));
    const response = await post(JSON.stringify({ files }));
    expect(response.status).toBe(400);
  });

  it("refuses a body that is not a files array", async () => {
    for (const body of ["null", '{"files":{}}', "[]", "not json at all"]) {
      const response = await post(body);
      expect(response.status, body).toBe(400);
    }
  });

  it("refuses a batch that is not sent as JSON", async () => {
    const response = await rawRequest(port, "/api/projects/p/write", {
      method: "POST",
      body: batch("project.json", renamedProject("nope")),
      contentType: "text/plain",
      token: TOKEN,
      origin,
    });
    expect(response.status).toBe(415);
  });

  it("rejects the whole batch when any file in it is refused", async () => {
    const before = readFileSync(join(root, "project.json"), "utf8");
    const body = JSON.stringify({
      files: [
        { path: "project.json", contents: renamedProject("landed"), expectedHash: diskHash("project.json") },
        { path: "../escaped.json", contents: "{}\n", expectedHash: null },
      ],
    });

    const response = await post(body);

    expect(response.status).toBe(403);
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(before);
  });
});

describe("write endpoint concurrency preconditions", () => {
  it("refuses a write whose file changed on disk underneath it, and keeps the other edit", async () => {
    // The real sequence: this editor reads the project, an agent edits the same
    // file, and the editor then tries to save the model it read before that.
    const stale = diskHash("project.json");
    const external = renamedProject("Edited by the agent");
    writeFileSync(join(root, "project.json"), external);

    const response = await post(batch("project.json", renamedProject("Edited by the UI"), stale));

    expect(response.status).toBe(409);
    expect(response.body).toContain("project.json");
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(external);
    expect(loadProject(root).project!.project.name).toBe("Edited by the agent");
  });

  it("accepts the same write once the caller has caught up with disk", async () => {
    const external = renamedProject("Edited by the agent");
    writeFileSync(join(root, "project.json"), external);
    const mine = renamedProject("Edited by the UI, after reloading");

    const response = await post(batch("project.json", mine, diskHash("project.json")));

    expect(response.status).toBe(200);
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(mine);
  });

  it("refuses a create whose file already exists", async () => {
    const response = await post(batch("project.json", renamedProject("Surprise"), null));

    expect(response.status).toBe(409);
    expect(loadProject(root).project!.project.name).not.toBe("Surprise");
  });

  it("refuses a write to a file the caller thinks exists but does not", async () => {
    const automation = readFileSync(join(root, "automation/pad.json"), "utf8");
    const stale = diskHash("automation/pad.json");
    rmSync(join(root, "automation/pad.json"));

    const response = await post(batch("automation/pad.json", automation, stale));

    expect(response.status).toBe(409);
    expect(existsSync(join(root, "automation/pad.json"))).toBe(false);
  });

  it("rejects the whole batch when only one of its files conflicts", async () => {
    const projectBefore = readFileSync(join(root, "project.json"), "utf8");
    const staleTrack = diskHash("tracks/drums.json");
    // Someone else touched only the track file; the project file is untouched,
    // so its own precondition is fine and only the batch as a whole can fail.
    writeFileSync(join(root, "tracks/drums.json"), `${readFileSync(join(root, "tracks/drums.json"), "utf8")}\n`);

    const body = JSON.stringify({
      files: [
        { path: "project.json", contents: renamedProject("Should not land"), expectedHash: diskHash("project.json") },
        { path: "tracks/drums.json", contents: canonical("tracks/drums.json"), expectedHash: staleTrack },
      ],
    });
    const response = await post(body);

    expect(response.status).toBe(409);
    expect(response.body).toContain("tracks/drums.json");
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(projectBefore);
  });

  /**
   * Resolving a write path used to create the document directory it names, and
   * resolving happens during planning — before the batch-wide precondition
   * check. A refused batch therefore left an empty `automation/` behind, which
   * is a project the user did not ask for: `describe` and the directory scan
   * both see a document directory that appeared out of a write nobody accepted.
   */
  it("leaves no directory behind when the batch it was creating for is refused", async () => {
    const contents = canonical("automation/pad.json");
    const projectBefore = readFileSync(join(root, "project.json"), "utf8");
    rmSync(join(root, "automation"), { recursive: true });

    // The automation file's own precondition is fine — it genuinely is absent.
    // The batch fails on the *other* file, so the only reason `automation/`
    // could exist afterwards is a write path that created it too eagerly.
    const body = JSON.stringify({
      files: [
        { path: "automation/pad.json", contents, expectedHash: null },
        { path: "project.json", contents: renamedProject("Should not land"), expectedHash: "not-the-hash-on-disk" },
      ],
    });
    const response = await post(body);

    expect(response.status).toBe(409);
    expect(existsSync(join(root, "automation"))).toBe(false);
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(projectBefore);
  });

  it("refuses a write that omits its precondition entirely", async () => {
    const body = JSON.stringify({ files: [{ path: "project.json", contents: renamedProject("No precondition") }] });

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(response.body).toContain("expectedHash");
    expect(loadProject(root).project!.project.name).not.toBe("No precondition");
  });

  it("hands back the hash to present next time, so a sequence of writes needs no re-read", async () => {
    const first = renamedProject("First");
    const response = await post(batch("project.json", first));
    const ack = (JSON.parse(response.body) as WriteResponse).written[0]!;

    const second = await post(batch("project.json", renamedProject("Second"), ack.contentHash));

    expect(second.status).toBe(200);
    expect(loadProject(root).project!.project.name).toBe("Second");
  });
});

describe("write endpoint success path", () => {
  it("persists canonical bytes and reports the project's diagnostics afterwards", async () => {
    const contents = renamedProject("Renamed by the UI");

    const response = await post(batch("project.json", contents));

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as WriteResponse;
    expect(body.written.map((ack) => ack.path)).toEqual(["project.json"]);
    expect(body.written[0]!.bytes).toBe(Buffer.byteLength(contents));
    expect(body.summary.ok).toBe(true);
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(contents);
    expect(loadProject(root).project!.project.name).toBe("Renamed by the UI");
  });

  it("leaves no temporary files behind, and none the loader would warn about", async () => {
    await post(batch("project.json", renamedProject("Temp check")));

    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(loadProject(root).diagnostics).toEqual([]);
  });

  it("creates a document directory that the project does not have yet", async () => {
    rmSync(join(root, "automation"), { recursive: true, force: true });
    const automation = serializeCanonical(
      { track: "pad", lanes: [{ param: "filterCutoff", interp: "linear", points: [[0, 500]] }] } as never,
      "automation",
    );

    const response = await post(batch("automation/pad.json", automation, null));

    expect(response.status).toBe(200);
    expect(readFileSync(join(root, "automation/pad.json"), "utf8")).toBe(automation);
  });

  it("writes a multi-file batch as one unit", async () => {
    const body = JSON.stringify({
      files: [
        { path: "project.json", contents: renamedProject("Two files"), expectedHash: diskHash("project.json") },
        {
          path: "tracks/drums.json",
          contents: canonical("tracks/drums.json"),
          expectedHash: diskHash("tracks/drums.json"),
        },
      ],
    });

    const response = await post(body);

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as WriteResponse).written.map((ack) => ack.path)).toEqual([
      "project.json",
      "tracks/drums.json",
    ]);
    expect(loadProject(root).project!.project.name).toBe("Two files");
  });

  it("refuses to write into a project it does not serve", async () => {
    mkdirSync(join(root, "..", "other"), { recursive: true });
    const response = await post(batch("project.json", renamedProject("nope")), { path: "/api/projects/other/write" });
    expect(response.status).toBe(404);
    rmSync(join(root, "..", "other"), { recursive: true, force: true });
  });
});
