import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashContent } from "@chord-garden/engine/live";
import { loadProject, serializeCanonical } from "@chord-garden/format";
import { SNAPSHOT_PATH, type ProjectSnapshot } from "../src/api.js";
import { ProjectClient } from "../src/client.js";
import { createAssetServer } from "../src/server.js";
import { rawRequest } from "./helpers.js";

/**
 * The whole-project read, and the reason it exists: a load that cannot be torn.
 *
 * `client.loadProject` used to fetch the summary and then each document, which is
 * not atomic with respect to an agent editing the files. The browser could end up
 * holding half of one disk state and half of another — a project no validation ever
 * passed, whose write preconditions describe a disk that never existed — and the
 * mixture was only *detected* later, by the inventory check on the next push. These
 * tests hold the property that makes it unreachable instead: one request.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const TOKEN = "snapshot-token-0123456789abcdef";

let server: Server;
let port: number;
let root: string;
let requests: string[];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chord-garden-snapshot-")));
  cpSync(FIXTURE, root, { recursive: true });
  requests = [];
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
    log: (line) => requests.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  rmSync(root, { recursive: true, force: true });
});

function client(): ProjectClient {
  return new ProjectClient(TOKEN, `http://127.0.0.1:${port}`);
}

/** Requests the server logged that read project data, in order. */
function projectReads(): string[] {
  return requests.filter((line) => line.startsWith("GET /api/projects/"));
}

/** Every document on disk right now, by project-relative path. */
function diskNow(): Map<string, string> {
  const result = loadProject(root);
  return new Map([...result.files.values()].map((file) => [file.path, file.text]));
}

function renamedProject(name: string): string {
  const doc = structuredClone(loadProject(root).project!.project);
  doc.name = name;
  return serializeCanonical(doc as never, "project");
}

function sameTexts(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, text] of a) {
    if (b.get(path) !== text) return false;
  }
  return true;
}

describe("the snapshot endpoint", () => {
  it("serves every document with the bytes it validated", async () => {
    const response = await rawRequest(port, `/api/projects/p/${SNAPSHOT_PATH}`, { token: TOKEN });
    expect(response.status).toBe(200);

    const snapshot = JSON.parse(response.body) as ProjectSnapshot;
    expect(snapshot.ok).toBe(true);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.files.map((file) => file.path)).toEqual([...diskNow().keys()].sort());
    for (const file of snapshot.files) {
      // The bytes are the file's, and the hash is the hash of those bytes: the
      // browser's write preconditions are made of both, so a disagreement between
      // them would be a precondition that can never match.
      expect(file.text, file.path).toBe(readFileSync(join(root, file.path), "utf8"));
      expect(file.contentHash, file.path).toBe(hashContent(Buffer.from(file.text, "utf8")));
    }
  });

  it("reports a project that does not validate rather than refusing to answer", async () => {
    writeFileSync(join(root, "patterns/drums-verse.json"), "{ not json", "utf8");

    const snapshot = JSON.parse(
      (await rawRequest(port, `/api/projects/p/${SNAPSHOT_PATH}`, { token: TOKEN })).body,
    ) as ProjectSnapshot;

    expect(snapshot.ok).toBe(false);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });

  it("needs the session token and a project that exists", async () => {
    expect((await rawRequest(port, `/api/projects/p/${SNAPSHOT_PATH}`)).status).toBe(401);
    expect((await rawRequest(port, `/api/projects/nope/${SNAPSHOT_PATH}`, { token: TOKEN })).status).toBe(404);
  });

  it("is read-only", async () => {
    const response = await rawRequest(port, `/api/projects/p/${SNAPSHOT_PATH}`, {
      method: "POST",
      token: TOKEN,
      body: "{}",
      origin: `http://127.0.0.1:${port}`,
    });
    expect(response.status).toBe(405);
  });
});

describe("loading a project over HTTP", () => {
  it("reads the whole project in one request", async () => {
    const loaded = await client().loadProject("p");

    expect(loaded.project.tracks.size).toBe(3);
    expect(loaded.texts.size).toBe(11);
    // The guard: one read of the disk. A load made of several reads is a load that
    // can observe two different disk states, and no amount of care downstream can
    // reassemble a project from a mixture.
    expect(projectReads()).toEqual([`GET /api/projects/p/${SNAPSHOT_PATH}`]);
  });

  it("hands the store exactly the bytes on disk, non-canonical ones included", async () => {
    // A hand-edited file that is valid but not canonically formatted. The load must
    // carry its actual bytes, because that is what the write precondition hashes;
    // re-serializing here would make every such file look like an edit.
    const scruffy = `${readFileSync(join(root, "project.json"), "utf8")}\n`;
    writeFileSync(join(root, "project.json"), scruffy, "utf8");

    const loaded = await client().loadProject("p");

    expect(loaded.texts.get("project.json")).toBe(scruffy);
  });

  it("cannot assemble a project from two disk states", async () => {
    // An agent editing continuously while the load runs: one write after every
    // response the load receives. With one request there is no "during" left — the
    // edit is either in the snapshot or after it — so what the store receives is
    // always exactly one state of the disk.
    //
    // Under a per-document load these writes land *between* document fetches, and
    // the assertion below fails, because the result then matches neither the disk
    // before the load nor the disk after it.
    const before = diskNow();
    const originalFetch = globalThis.fetch;
    let responses = 0;
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await originalFetch(input, init);
      responses += 1;
      writeFileSync(join(root, "project.json"), renamedProject(`Edited mid-load ${responses}`), "utf8");
      return response;
    };
    try {
      const loaded = await client().loadProject("p");
      const after = diskNow();
      expect(sameTexts(before, after)).toBe(false);
      expect(
        sameTexts(loaded.texts, before) || sameTexts(loaded.texts, after),
        "the loaded documents came from more than one state of the disk",
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to load a project that does not validate", async () => {
    writeFileSync(join(root, "patterns/drums-verse.json"), "{ not json", "utf8");

    await expect(client().loadProject("p")).rejects.toThrow(/does not validate/);
  });
});

describe("a sidecar that contradicts itself", () => {
  it("refuses a document whose bytes do not hash to the hash beside them", async () => {
    // Not a case the server can produce, and that is the point: if it ever does, the
    // symptom without this check is write preconditions that never match, arriving
    // much later and nowhere near the cause.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await originalFetch(input, init);
      if (!String(input).endsWith(`/${SNAPSHOT_PATH}`)) return response;
      const snapshot = (await response.json()) as ProjectSnapshot;
      snapshot.files[0]!.contentHash = "not-the-hash-of-these-bytes";
      return new Response(JSON.stringify(snapshot), { status: 200, headers: response.headers });
    };
    try {
      await expect(client().loadProject("p")).rejects.toThrow(/disagree/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
