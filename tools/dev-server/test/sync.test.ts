import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalFiles, loadProject, serializeCanonical } from "@chord-garden/format";
import {
  CLOSE_ALREADY_OPEN,
  SYNC_PROTOCOL,
  type ProjectChangedMessage,
  type ServerMessage,
  type WriteRequest,
  type WriteResponse,
} from "../src/api.js";
import { createAssetServer } from "../src/server.js";
import { ProjectSync } from "../src/sync.js";
import { hashOnDisk } from "../src/write.js";
import { rawRequest } from "./helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const TOKEN = "sync-token-0123456789abcdef";
const SETTLE_MS = 20;
/**
 * How long a test waits for a push. Generous: it is bounded by the OS deciding
 * to deliver a filesystem event, which is not something to be tight about.
 */
const WAIT_MS = 4000;
/** How long "nothing was pushed" waits before believing it. */
const SILENCE_MS = 400;

let server: Server;
let sync: ProjectSync;
let port: number;
let root: string;
const sockets: TestSocket[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chord-garden-sync-")));
  cpSync(FIXTURE, root, { recursive: true });
  sync = new ProjectSync({
    mount: { name: "p", root },
    token: TOKEN,
    settleMs: SETTLE_MS,
    maxSettleMs: 200,
    helloTimeoutMs: 300,
  });
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
    syncs: new Map([["p", sync]]),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.dispose();
  sync.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  rmSync(root, { recursive: true, force: true });
});

/** A sync socket, with the queue-and-await plumbing a protocol test needs. */
class TestSocket {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((message: ServerMessage) => void) | undefined;
  private readonly socket: WebSocket;
  closed: { code: number; reason: string } | undefined;

  constructor(port: number, path = "/api/projects/p/socket") {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      const waiter = this.waiter;
      if (waiter !== undefined) {
        this.waiter = undefined;
        waiter(message);
      } else {
        this.queue.push(message);
      }
    });
    this.socket.addEventListener("close", (event: CloseEvent) => {
      this.closed = { code: event.code, reason: event.reason };
    });
  }

  /** Send the handshake once the socket is open. */
  async hello(overrides: Record<string, unknown> = {}): Promise<void> {
    if (this.socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve, reject) => {
        this.socket.addEventListener("open", () => resolve());
        this.socket.addEventListener("error", () => reject(new Error("socket failed to open")));
      });
    }
    this.socket.send(JSON.stringify({ type: "hello", protocol: SYNC_PROTOCOL, token: TOKEN, project: "p", ...overrides }));
  }

  send(text: string): void {
    this.socket.send(text);
  }

  next(timeoutMs = WAIT_MS): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`no sync message within ${timeoutMs}ms (socket ${this.closed === undefined ? "open" : `closed ${this.closed.code} ${this.closed.reason}`})`));
      }, timeoutMs);
      this.waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  /** Assert that nothing at all arrives for a while. */
  async expectSilence(ms = SILENCE_MS): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.queue.length > 0) {
      throw new Error(`expected no push, got ${JSON.stringify(this.queue)}`);
    }
  }

  /** Wait for the socket to be closed by the server. */
  async waitForClose(timeoutMs = WAIT_MS): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (this.closed === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.closed === undefined) throw new Error("socket was not closed");
    return this.closed;
  }

  dispose(): void {
    this.socket.close();
  }
}

/** An authenticated, welcomed socket — the state every sync test starts from. */
async function editorSocket(): Promise<TestSocket> {
  const socket = new TestSocket(port);
  sockets.push(socket);
  await socket.hello();
  const welcome = await socket.next();
  expect(welcome).toMatchObject({ type: "welcome", protocol: SYNC_PROTOCOL, project: "p" });
  return socket;
}

/** Canonical bytes of one document of the project as it stands. */
function canonical(path: string): string {
  const result = loadProject(root);
  if (result.project === undefined) throw new Error(`project does not load: ${JSON.stringify(result.diagnostics)}`);
  const bytes = canonicalFiles(result.project).get(path);
  if (bytes === undefined) throw new Error(`no canonical bytes for ${path}`);
  return bytes;
}

/** project.json with a different name, canonically serialized. */
function renamedProject(name: string): string {
  const result = loadProject(root);
  const doc = structuredClone(result.project!.project);
  doc.name = name;
  return serializeCanonical(doc as never, "project");
}

/** Write a file the way an agent does: directly, with no sidecar involved. */
function externalEdit(path: string, contents: string): void {
  writeFileSync(join(root, path), contents, "utf8");
}

/** Write through the sidecar, the way the UI does, precondition and all. */
async function uiWrite(files: { path: string; contents: string }[]): Promise<WriteResponse> {
  const body: WriteRequest = {
    files: files.map((file) => ({ ...file, expectedHash: hashOnDisk(join(root, file.path)) })),
  };
  const response = await rawRequest(port, "/api/projects/p/write", {
    method: "POST",
    body: JSON.stringify(body),
    token: TOKEN,
    origin: `http://127.0.0.1:${port}`,
  });
  if (response.status !== 200) throw new Error(`write failed: ${response.status} ${response.body}`);
  return JSON.parse(response.body) as WriteResponse;
}

/** A raw upgrade attempt, for the header checks a WebSocket client cannot forge. */
function rawUpgrade(
  path: string,
  headers: Record<string, string>,
): Promise<{ upgraded: boolean; status?: number; body?: string }> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    call.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve({ upgraded: true });
    });
    call.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ upgraded: false, status: response.statusCode ?? 0, body }));
    });
    call.on("error", reject);
    call.end();
  });
}

function changed(message: ServerMessage): ProjectChangedMessage {
  if (message.type !== "projectChanged") {
    throw new Error(`expected a projectChanged message, got ${JSON.stringify(message)}`);
  }
  return message;
}

describe("external edits", () => {
  it("pushes a validated snapshot naming the file an agent edited", async () => {
    const socket = await editorSocket();
    const before = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");

    externalEdit("patterns/drums-verse.json", before.replace('"x..x ..x. x..x ..x."', '"x..x ..x. x..x ..xx"'));

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["patterns/drums-verse.json"]);
    expect(message.removed).toEqual([]);
    // The bytes pushed are the bytes on disk, not a re-serialization of them: the
    // browser's write precondition is made of these.
    expect(message.changed[0]!.text).toBe(readFileSync(join(root, "patterns/drums-verse.json"), "utf8"));
    expect(message.changed[0]!.kind).toBe("pattern.grid");
    // The inventory covers the whole bundle so the browser can prove it is complete.
    expect(message.files.length).toBeGreaterThan(1);
    expect(message.files.map((file) => file.path)).toContain("project.json");
  });

  it("coalesces a burst of edits into one push", async () => {
    const socket = await editorSocket();

    externalEdit("project.json", renamedProject("First"));
    externalEdit("project.json", renamedProject("Second"));
    externalEdit("project.json", renamedProject("Third"));

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["project.json"]);
    expect(message.changed[0]!.text).toContain('"name": "Third"');
    await socket.expectSilence();
  });

  it("reports a document that was deleted", async () => {
    const socket = await editorSocket();

    unlinkSync(join(root, "automation/pad.json"));

    const message = changed(await socket.next());
    expect(message.removed).toEqual(["automation/pad.json"]);
    expect(message.files.map((file) => file.path)).not.toContain("automation/pad.json");
  });

  it("says nothing about a file rewritten with the same bytes", async () => {
    const socket = await editorSocket();
    const path = join(root, "patterns/drums-verse.json");

    // What `musictool fmt` does to an already-canonical project, or a save from an
    // editor with no changes: mtime moves, content does not.
    writeFileSync(path, readFileSync(path, "utf8"), "utf8");

    await socket.expectSilence();
  });

  it("ignores changes to files that are not project documents", async () => {
    const socket = await editorSocket();

    writeFileSync(join(root, "samples/kick.wav.bak"), "not a document", "utf8");
    writeFileSync(join(root, "notes.txt"), "scratch", "utf8");

    await socket.expectSilence();
  });
});

describe("echo detection", () => {
  it("does not report the sidecar's own write back to the UI", async () => {
    const socket = await editorSocket();

    await uiWrite([{ path: "project.json", contents: renamedProject("Written by the UI") }]);

    // The watcher certainly saw that write. It must recognise the bytes as ones
    // it put there, or the UI reconciles its own edit and writes again, forever.
    await socket.expectSilence();
    expect(sync.establishedText("project.json")).toBe(renamedProject("Written by the UI"));
  });

  it("does not report a multi-file batch it wrote itself", async () => {
    const socket = await editorSocket();

    await uiWrite([
      { path: "project.json", contents: renamedProject("Batch") },
      { path: "patterns/drums-verse.json", contents: canonical("patterns/drums-verse.json").replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx") },
    ]);

    await socket.expectSilence();
  });

  it("still reports an external edit that lands in the same settle window as our write", async () => {
    // The asymmetric case, and the reason echo detection is content-based rather
    // than time-based: a "suppress events for N ms after writing" implementation
    // passes every test above and silently eats this agent edit.
    const socket = await editorSocket();

    await uiWrite([{ path: "project.json", contents: renamedProject("From the UI") }]);
    externalEdit("project.json", renamedProject("From the agent"));

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["project.json"]);
    expect(message.changed[0]!.text).toContain('"name": "From the agent"');
  });

  it("reports only the file the agent touched when a write and an edit interleave", async () => {
    const socket = await editorSocket();

    await uiWrite([{ path: "project.json", contents: renamedProject("Ours") }]);
    externalEdit(
      "patterns/drums-verse.json",
      readFileSync(join(root, "patterns/drums-verse.json"), "utf8").replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"),
    );

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["patterns/drums-verse.json"]);
  });
});

describe("invalid intermediate states", () => {
  it("reports that the disk does not validate, and adopts nothing", async () => {
    const socket = await editorSocket();

    // A step count that does not match the grid: exactly the state a half-finished
    // agent edit leaves behind.
    externalEdit(
      "patterns/drums-verse.json",
      readFileSync(join(root, "patterns/drums-verse.json"), "utf8").replace("x..x ..x. x..x ..x.", "x..x ..x. x..x"),
    );

    const message = await socket.next();
    expect(message.type).toBe("projectInvalid");
    if (message.type !== "projectInvalid") return;
    expect(message.diagnostics.some((diagnostic) => diagnostic.code === "pattern.step-count-mismatch")).toBe(true);
    // Nothing consumed: the broken bytes are not what the sidecar has established.
    expect(sync.establishedText("patterns/drums-verse.json")).not.toContain('"x..x ..x. x..x"');
  });

  it("delivers a multi-file edit as one snapshot once it validates", async () => {
    const socket = await editorSocket();
    const pattern = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");

    // Step one of an agent's two-file edit leaves the project invalid.
    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x"));
    expect((await socket.next()).type).toBe("projectInvalid");

    // Step two fixes it and touches a second file.
    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"));
    externalEdit("project.json", renamedProject("Two files at once"));

    const message = changed(await socket.next());
    // Both files arrive together, because nothing was consumed while it was broken.
    expect(message.changed.map((file) => file.path).sort()).toEqual(["patterns/drums-verse.json", "project.json"]);
    await socket.expectSilence();
  });

  it("keeps refusing to adopt while the project stays broken", async () => {
    const socket = await editorSocket();
    const pattern = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");

    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x"));
    expect((await socket.next()).type).toBe("projectInvalid");
    externalEdit("patterns/drums-verse.json", "{ this is not even JSON");
    expect((await socket.next()).type).toBe("projectInvalid");
    expect(sync.establishedText("patterns/drums-verse.json")).toBe(pattern);
  });
});

describe("the single-writer session", () => {
  it("refuses a second browser and names the reason", async () => {
    await editorSocket();

    const second = new TestSocket(port);
    sockets.push(second);
    await second.hello();

    const message = await second.next();
    expect(message).toMatchObject({ type: "rejected" });
    if (message.type !== "rejected") return;
    expect(message.reason).toContain("another window");
    expect((await second.waitForClose()).code).toBe(CLOSE_ALREADY_OPEN);
    expect(sync.hasEditor).toBe(true);
  });

  it("admits a new session once the first one goes away", async () => {
    const first = await editorSocket();
    first.dispose();
    // The slot is released by the socket closing, not by a timer.
    for (let attempt = 0; attempt < 200 && sync.hasEditor; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sync.hasEditor).toBe(false);

    const second = await editorSocket();
    externalEdit("project.json", renamedProject("For the second window"));
    expect(changed(await second.next()).changed.map((file) => file.path)).toEqual(["project.json"]);
  });

  it("pushes nothing when no browser is connected, and still tracks the disk", async () => {
    externalEdit("project.json", renamedProject("Nobody is watching"));
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    expect(sync.establishedText("project.json")).toContain("Nobody is watching");

    // A browser arriving later loads over HTTP, so the change is not lost; what
    // matters is that the next edit is still reported as a diff.
    const socket = await editorSocket();
    externalEdit("project.json", renamedProject("Now it is"));
    expect(changed(await socket.next()).changed[0]!.text).toContain("Now it is");
  });
});

describe("socket authentication and limits", () => {
  it("refuses a hello with the wrong token", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello({ token: "not-the-session-token" });

    expect(await socket.next()).toMatchObject({ type: "rejected", reason: expect.stringContaining("token") });
    await socket.waitForClose();
    expect(sync.hasEditor).toBe(false);
  });

  it("refuses a hello from an older protocol", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello({ protocol: SYNC_PROTOCOL - 1 });

    expect(await socket.next()).toMatchObject({ type: "rejected", reason: expect.stringContaining("reload") });
  });

  it("refuses a hello for a different project", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello({ project: "somewhere-else" });

    expect(await socket.next()).toMatchObject({ type: "rejected" });
  });

  it("refuses a first message that is not a hello", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello();
    // Replace the hello with something else by connecting a fresh socket.
    const other = new TestSocket(port);
    sockets.push(other);
    await new Promise<void>((resolve) => other["socket"].addEventListener("open", () => resolve()));
    other.send(JSON.stringify({ type: "writeFile", path: "project.json" }));

    expect(await other.next()).toMatchObject({ type: "error", message: expect.stringContaining("hello") });
    await other.waitForClose();
  });

  it("refuses a message sent after the handshake", async () => {
    const socket = await editorSocket();
    socket.send(JSON.stringify({ type: "hello", protocol: SYNC_PROTOCOL, token: TOKEN, project: "p" }));

    expect(await socket.next()).toMatchObject({ type: "error" });
    await socket.waitForClose();
  });

  it("closes a socket that says nothing at all", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);
    const close = await socket.waitForClose();
    expect(close.reason).toContain("hello");
  });

  it("closes a socket that sends more than the message limit", async () => {
    const socket = await editorSocket();
    socket.send(JSON.stringify({ type: "hello", padding: "x".repeat(100_000) }));

    const close = await socket.waitForClose();
    expect(close.code).toBe(1009);
  });

  it("refuses an upgrade from another origin", async () => {
    const refused = await rawUpgrade("/api/projects/p/socket", {
      host: `127.0.0.1:${port}`,
      origin: "http://evil.example.com",
    });
    expect(refused.upgraded).toBe(false);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("origin");
  });

  it("refuses an upgrade for a non-loopback host", async () => {
    const refused = await rawUpgrade("/api/projects/p/socket", { host: "attacker.example.com" });
    expect(refused.upgraded).toBe(false);
    expect(refused.status).toBe(403);
  });

  it("404s a socket path with no project behind it", async () => {
    const refused = await rawUpgrade("/api/projects/nope/socket", { host: `127.0.0.1:${port}` });
    expect(refused.status).toBe(404);
    const wrongPath = await rawUpgrade("/api/projects/p/files", { host: `127.0.0.1:${port}` });
    expect(wrongPath.status).toBe(404);
  });

  it("refuses an upgrade that is not WebSocket 13", async () => {
    const refused = await rawUpgrade("/api/projects/p/socket", {
      host: `127.0.0.1:${port}`,
      "sec-websocket-version": "8",
    });
    expect(refused.status).toBe(400);
  });
});
