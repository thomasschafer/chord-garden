import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "@chord-garden/cli";
import { canonicalFiles, loadProject } from "@chord-garden/format";
import { createAssetServer } from "@chord-garden/dev-server";
import { TOKEN_HEADER, WRITE_CONFLICT_STATUS } from "@chord-garden/dev-server/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentStore,
  hashText,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
  type PendingFile,
} from "../src/store/documentStore";
import { FIXTURE, REPO_ROOT, openedFrom } from "./fixture";

/**
 * The invariant that makes the UI "one editor among two" (PLAN.md §3): a project
 * edited in the app and a project run through `musictool fmt` are byte-identical.
 *
 * Everything real: a temp copy of the fixture, the actual dev server with its
 * actual write endpoint, the actual store, and the actual CLI. The only stand-in
 * is the browser itself — the sink below sends the request a browser would,
 * including the `Origin` header the browser attaches and this test cannot get
 * `fetch` to attach.
 */

const TOKEN = "byte-identity-token-0123456789";

let server: Server;
let port: number;
let root: string;
let store: DocumentStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "chord-garden-identity-"));
  cpSync(FIXTURE, root, { recursive: true });
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  store = createDocumentStore({ sink: httpSink() });
  store.getState().open(openedFrom(root));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  rmSync(root, { recursive: true, force: true });
});

/**
 * Posts a write batch the way the app's `ProjectClient` does, plus the `Origin`
 * header a browser attaches and `fetch` will not let a test set.
 *
 * The 409 translation mirrors `app/src/session.ts`: turning a transport status
 * into the store's own conflict type is a boundary concern, and each transport
 * does it for itself. The shared constant keeps the status from being written
 * down twice, and the tests below assert the raw status as well as the effect,
 * so a drift in this mapping cannot hide a drift in the server.
 */
function httpSink(): DocumentSink {
  return {
    async write(files: readonly PendingFile[]) {
      const response = await post("/api/projects/p/write", JSON.stringify({ files }));
      if (response.status === WRITE_CONFLICT_STATUS) {
        throw new WriteConflictError(response.body, files.map((file) => file.path));
      }
      if (response.status !== 200) throw new Error(`write failed: ${response.status} ${response.body}`);
      return { diagnostics: [] };
    },
  };
}

function post(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [TOKEN_HEADER]: TOKEN,
          origin: `http://127.0.0.1:${port}`,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    call.on("error", reject);
    call.write(body);
    call.end();
  });
}

/** `musictool fmt --check`: exit 0 and "already canonical" means fmt agrees. */
function fmtCheck(): { code: number; stdout: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: { write: (value) => (stdout += value) }, stderr: { write: (value) => (stderr += value) } };
  const code = runCli(["fmt", root, "--check"], io);
  return { code, stdout: stdout + stderr };
}

/** Every document's bytes on disk right now. */
function onDisk(): Map<string, string> {
  const result = loadProject(root);
  if (result.project === undefined) throw new Error(`project stopped loading: ${JSON.stringify(result.diagnostics)}`);
  const bytes = new Map<string, string>();
  for (const path of result.files.keys()) bytes.set(path, readFileSync(join(root, path), "utf8"));
  return bytes;
}

describe("a UI edit is byte-identical to what the CLI would write", () => {
  it("leaves the project already canonical after a project-level edit", async () => {
    store.getState().setProjectName("Edited in the UI");
    store.getState().setTempoBpmX100(13_000);
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    // Stated the other way round too, so a change in `fmt`'s reporting cannot
    // quietly weaken this: the bytes on disk are what `canonicalFiles` produces
    // for the project those bytes parse back into.
    const reloaded = loadProject(root);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    expect(reloaded.project!.project.name).toBe("Edited in the UI");
    expect(reloaded.project!.project.tempoMap[0]!.bpm).toBe(13_000);
  });

  it("leaves the project already canonical after a pattern edit", async () => {
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x... x... x... x...");
    await store.getState().flushNow();

    expect(fmtCheck().stdout).toBe("already canonical\n");
    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    const pattern = reloaded.project!.patterns.get("drums-verse")!;
    expect(pattern.kind === "grid" && pattern.lanes[0]!.steps).toBe("x... x... x... x...");
  });

  it("writes exactly the bytes the store held, with no server-side reformatting", async () => {
    store.getState().setProjectName("Byte for byte");
    const expected = store.getState().canonical.get("project.json");
    await store.getState().flushNow();

    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(expected);
  });

  it("touches only the file that changed, leaving the other ten alone", async () => {
    const before = new Map([...onDisk().keys()].map((path) => [path, statSync(join(root, path)).mtimeMs]));
    expect(before.size).toBe(11);
    // A coarse clock would make "unchanged mtime" meaningless; a real pause is
    // cheaper than reasoning about filesystem timestamp granularity.
    await new Promise((resolve) => setTimeout(resolve, 20));

    store.getState().setPatternLaneSteps("drums-verse", "kick", "x..x x..x x..x x..x");
    await store.getState().flushNow();

    const after = new Map([...onDisk().keys()].map((path) => [path, statSync(join(root, path)).mtimeMs]));
    const rewritten = [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path);
    expect(rewritten).toEqual(["patterns/drums-verse.json"]);
  });

  it("bites: the server refuses the bytes a hand-rolled serializer would produce", async () => {
    // What a UI that reached for `JSON.stringify` instead of `canonicalFiles`
    // would send. Same document, same values, different bytes — and the write
    // path is where that has to stop, because by the time it is on disk the
    // damage is a dirty diff nobody asked for.
    const project = loadProject(root).project!;
    const naive = `${JSON.stringify({ ...project.project, name: "Hand rolled" }, null, 2)}\n`;
    const before = readFileSync(join(root, "project.json"), "utf8");

    const response = await post(
      "/api/projects/p/write",
      JSON.stringify({ files: [{ path: "project.json", contents: naive, expectedHash: hashText(before) }] }),
    );

    expect(response.status).toBe(422);
    expect(response.body).toContain("canonical");
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(before);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  it("bites the other way: a non-canonical file on disk is reported by fmt, so the check is not vacuous", () => {
    // If `fmt --check` said "already canonical" no matter what, every assertion
    // above would pass for the wrong reason.
    const project = loadProject(root).project!;
    writeFileSync(join(root, "project.json"), `${JSON.stringify(project.project, null, 4)}\n`);

    const check = fmtCheck();

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite project.json");
  });
});

describe("an external edit is refused, not overwritten", () => {
  it("stops the store writing over a file that changed underneath it", async () => {
    // Exactly the sequence that made this necessary: the app is open, its model
    // is written once, something else rewrites the file, and the app edits again.
    store.getState().setProjectName("Written by the UI");
    await store.getState().flushNow();
    expect(readFileSync(join(root, "project.json"), "utf8")).toContain('"name": "Written by the UI"');

    const external = readFileSync(join(root, "project.json"), "utf8").replace(
      '"name": "Written by the UI"',
      '"name": "Written by the agent"',
    );
    writeFileSync(join(root, "project.json"), external);

    store.getState().setProjectName("Written by the UI, second time");
    await store.getState().flushNow();

    // The agent's edit survives, the UI knows why, and it has stopped writing.
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(external);
    expect(loadProject(root).project!.project.name).toBe("Written by the agent");
    expect(store.getState().conflict?.paths).toEqual(["project.json"]);
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  it("recovers once the store reopens the project from disk", async () => {
    writeFileSync(
      join(root, "project.json"),
      readFileSync(join(root, "project.json"), "utf8").replace('"name": "first track"', '"name": "Agent wrote this"'),
    );
    store.getState().setProjectName("Stale");
    await store.getState().flushNow();
    expect(store.getState().conflict).toBeDefined();

    store.getState().open(openedFrom(root));
    expect(store.getState().project!.project.name).toBe("Agent wrote this");
    store.getState().setProjectName("Now allowed");
    await store.getState().flushNow();

    expect(store.getState().conflict).toBeUndefined();
    expect(loadProject(root).project!.project.name).toBe("Now allowed");
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });
});
