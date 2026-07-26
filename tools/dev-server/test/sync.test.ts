import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalFiles, loadProject, serializeCanonical } from "@chord-garden/format";
import { hashContent } from "@chord-garden/engine/live";
import { encodeWav } from "@chord-garden/engine/wav";
import {
  CLOSE_ALREADY_OPEN,
  inventoryHash,
  SNAPSHOT_PATH,
  SYNC_PROTOCOL,
  type ProjectChangedMessage,
  type SamplesChangedMessage,
  type ServerMessage,
  type WriteRequest,
  type WriteResponse,
} from "../src/api.js";
import { createAssetServer, readSnapshot } from "../src/server.js";
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
let syncs: Map<string, ProjectSync>;
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
  // Held in a map the test can rewrite, so `manualSync` can swap the watcher out
  // for one this file drives itself. The server reads it per request.
  syncs = new Map([["p", sync]]);
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
    syncs,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

/**
 * Replace this project's sync with one whose scans the test drives itself, and
 * which therefore has no filesystem watcher at all. Must be called before any
 * socket connects.
 *
 * This is how the race tests below stay deterministic. The settle window's entire
 * job is to turn a burst of filesystem events into exactly one scan — proved with a
 * fake clock in `watch.test.ts` — so "these things happened inside one settle
 * window" *is*, to everything downstream of the watcher, "these things happened to
 * the disk between two scans". Stating it that way costs nothing in fidelity and
 * removes both the sleeping and the dependence on when the OS feels like reporting
 * an unlink, which is precisely where a watcher test becomes flaky. Tests about
 * whether the real watcher notices at all keep using the real one, above.
 */
function manualSync(): ProjectSync {
  sync.close();
  sync = new ProjectSync({
    mount: { name: "p", root },
    token: TOKEN,
    helloTimeoutMs: 300,
    watchFilesystem: false,
  });
  syncs.set("p", sync);
  return sync;
}

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
  /** The write credential from the welcome, which every write must present. */
  session: string | undefined;

  constructor(port: number, path = "/api/projects/p/socket") {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "welcome") this.session = message.session;
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

  /** The session credential, or a loud failure: a test must not write without one. */
  get writeSession(): string {
    if (this.session === undefined) throw new Error("this socket never received a welcome, so it holds no session");
    return this.session;
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

/**
 * Wait out the filesystem events the *setup* caused, and assert they said nothing.
 *
 * Only for the tests that use the real watcher, and it is not a nicety. macOS
 * FSEvents delivers a recursive watch some events from just before the stream was
 * opened, so the `cpSync` that lays the fixture down in `beforeEach` reliably reaches
 * a watcher created afterwards: instrumenting `touch` shows nearly every test in this
 * file receiving an unsolicited `automation/pad.json` or `instruments/bass-synth.json`
 * event it never caused. The resulting scan is harmless on its own — the disk matches
 * what was established, so nothing is pushed, which is what this asserts — but it
 * lands at an unpredictable moment, and a scan in the middle of a test's own burst
 * either splits a coalesced push in two or does the work the test meant to attribute
 * to something else. Both make a green test worthless, and the second is a plausible
 * cause of a rare spurious failure.
 *
 * Not a substitute for the settle-window tests: those are in `watch.test.ts` on a fake
 * clock, and this only makes the real-OS tests start from a quiet disk.
 */
async function untilTheSetupIsQuiet(socket: TestSocket): Promise<void> {
  await socket.expectSilence();
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

/**
 * Write through the sidecar, the way the UI does: precondition, and the session
 * credential of the browser that holds this project.
 */
async function uiWrite(socket: TestSocket, files: { path: string; contents: string }[]): Promise<WriteResponse> {
  const response = await postWrite(files, socket.writeSession);
  if (response.status !== 200) throw new Error(`write failed: ${response.status} ${response.body}`);
  return JSON.parse(response.body) as WriteResponse;
}

/** A raw write POST, so a test can present the wrong session — or none. */
function postWrite(
  files: { path: string; contents: string }[],
  session: string | undefined,
): Promise<{ status: number; body: string }> {
  const body: WriteRequest = {
    files: files.map((file) => ({ ...file, expectedHash: hashOnDisk(join(root, file.path)) })),
  };
  return rawRequest(port, "/api/projects/p/write", {
    method: "POST",
    body: JSON.stringify(body),
    token: TOKEN,
    origin: `http://127.0.0.1:${port}`,
    ...(session === undefined ? {} : { session }),
  });
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

function samplesChanged(message: ServerMessage): SamplesChangedMessage {
  if (message.type !== "samplesChanged") {
    throw new Error(`expected a samplesChanged message, got ${JSON.stringify(message)}`);
  }
  return message;
}

/** The bytes of a sample as the project currently holds them. */
function sampleBytes(path: string): Buffer {
  return readFileSync(join(root, path));
}

/**
 * Replace a sample on disk, the way anyone auditioning a kick does: the file at the
 * same path, with different audio in it.
 *
 * A real WAV rather than a doctored one, so the project still validates and the case
 * under test is "the sound changed", not "the file broke".
 */
function replaceSample(path: string, level: number, frames = 400): Buffer {
  const bytes = Buffer.from(encodeWav({ sampleRate: 8000, left: new Float32Array(frames).fill(level) }, 16));
  writeFileSync(join(root, path), bytes);
  return bytes;
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
    // A scan landing between the writes below would push "First" or "Second" and this
    // would fail — not because coalescing broke, but because the setup's own filesystem
    // events reached the watcher late (see `untilTheSetupIsQuiet`).
    await untilTheSetupIsQuiet(socket);

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

    await uiWrite(socket, [{ path: "project.json", contents: renamedProject("Written by the UI") }]);

    // The watcher certainly saw that write. It must recognise the bytes as ones
    // it put there, or the UI reconciles its own edit and writes again, forever.
    await socket.expectSilence();
    expect(sync.establishedText("project.json")).toBe(renamedProject("Written by the UI"));
  });

  it("does not report a multi-file batch it wrote itself", async () => {
    const socket = await editorSocket();

    await uiWrite(socket, [
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

    await uiWrite(socket, [{ path: "project.json", contents: renamedProject("From the UI") }]);
    externalEdit("project.json", renamedProject("From the agent"));

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["project.json"]);
    expect(message.changed[0]!.text).toContain('"name": "From the agent"');
  });

  it("reports only the file the agent touched when a write and an edit interleave", async () => {
    const socket = await editorSocket();

    await uiWrite(socket, [{ path: "project.json", contents: renamedProject("Ours") }]);
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

describe("delete and recreate", () => {
  /**
   * The semantics under test, chosen because identity here is content and never
   * existence-over-time (PLAN.md §16 names this case):
   *
   * - gone and back with the same bytes, within one settle window → a non-event;
   * - gone and back with different bytes → an ordinary external edit;
   * - still gone → a removal, if the project is still a project without it;
   * - still gone and the project no longer validates → the last good model stays,
   *   diagnostics say why, nothing is adopted;
   * - and, because an intermediate state may have been reported, a return to the
   *   established bytes is announced anyway so the diagnostics are retracted.
   */
  it("says nothing about a document that vanishes and returns unchanged", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const path = join(root, "patterns/drums-verse.json");
    const before = readFileSync(path, "utf8");

    // A tool that moves or rewrites a file by unlinking and creating it, rather
    // than by renaming over it. Both events land inside one settle window.
    unlinkSync(path);
    writeFileSync(path, before, "utf8");
    manual.scan();

    await socket.expectSilence();
    expect(manual.establishedText("patterns/drums-verse.json")).toBe(before);

    // And the channel is not merely quiet because it is broken: the next real edit
    // is the very next message, so nothing was queued behind it either.
    externalEdit("project.json", renamedProject("Still listening"));
    manual.scan();
    expect(changed(await socket.next()).changed.map((file) => file.path)).toEqual(["project.json"]);
  });

  it("reports a document that vanishes and returns with different bytes as one edit", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const path = join(root, "patterns/drums-verse.json");
    const edited = readFileSync(path, "utf8").replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx");

    unlinkSync(path);
    writeFileSync(path, edited, "utf8");
    manual.scan();

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["patterns/drums-verse.json"]);
    expect(message.changed[0]!.text).toBe(edited);
    expect(message.removed).toEqual([]);
    await socket.expectSilence();
  });

  it("reports a document that stays gone as a removal, when the project is still valid without it", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    unlinkSync(join(root, "automation/pad.json"));
    manual.scan();

    const message = changed(await socket.next());
    expect(message.removed).toEqual(["automation/pad.json"]);
    expect(message.changed).toEqual([]);
    expect(message.files.map((file) => file.path)).not.toContain("automation/pad.json");
    expect(manual.establishedText("automation/pad.json")).toBeUndefined();
  });

  it("holds the last good model when a deletion breaks the project, and retracts it when the file returns", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const path = join(root, "patterns/drums-verse.json");
    const before = readFileSync(path, "utf8");

    // A removal that leaves a dangling reference is an invalid disk state, and gets
    // exactly the treatment every other invalid state gets.
    unlinkSync(path);
    manual.scan();

    const invalid = await socket.next();
    expect(invalid.type).toBe("projectInvalid");
    if (invalid.type !== "projectInvalid") return;
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain("ref.missing-pattern");
    // Nothing was consumed, so the bytes are still there to come back to.
    expect(manual.establishedText("patterns/drums-verse.json")).toBe(before);

    // The file comes back byte-identical: there is now no content difference left
    // to report, and yet the UI is sitting on an error about a state that no longer
    // exists. So the recovery is announced with nothing changed in it.
    writeFileSync(path, before, "utf8");
    manual.scan();

    const recovery = changed(await socket.next());
    expect(recovery.changed).toEqual([]);
    expect(recovery.removed).toEqual([]);
    expect(recovery.scope).toBe("diff");
    expect(recovery.files.map((file) => file.path)).toContain("patterns/drums-verse.json");
    expect(recovery.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await socket.expectSilence();
  });

  it("reports a deletion and a recreation with new bytes together when the project broke in between", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const path = join(root, "patterns/drums-verse.json");
    const before = readFileSync(path, "utf8");

    unlinkSync(path);
    manual.scan();
    expect((await socket.next()).type).toBe("projectInvalid");

    writeFileSync(path, before.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"), "utf8");
    externalEdit("project.json", renamedProject("Moved a pattern about"));
    manual.scan();

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path).sort()).toEqual(["patterns/drums-verse.json", "project.json"]);
    await socket.expectSilence();
  });

  it("keeps the last good model when the whole project directory is emptied", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    rmSync(join(root, "project.json"));
    rmSync(join(root, "patterns"), { recursive: true, force: true });
    manual.scan();

    const message = await socket.next();
    expect(message.type).toBe("projectInvalid");
    if (message.type !== "projectInvalid") return;
    expect(message.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project.missing-file");
    // Not one file of it was consumed, so the model in the browser is still whole.
    expect(manual.establishedText("project.json")).toBeDefined();
    expect(manual.establishedText("patterns/drums-verse.json")).toBeDefined();
  });
});

describe("sample replacement", () => {
  /**
   * The hole this closes (PLAN.md §14, §16's Phase 2 criterion): replacing
   * `samples/kick.wav` changes what the project *sounds* like while changing no
   * document at all. The watcher used to filter `samples/` out entirely, so the
   * offline render picked the new file up and a running app kept playing the old audio
   * with nothing said about it — the one remaining place where the disk and what you
   * hear could silently disagree.
   *
   * A sample change is therefore its own message with its own inventory. It is not
   * folded into a `projectChanged`, because there is no changed document to put in one.
   */
  it("announces a replaced sample by content hash, and says nothing about the documents", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const before = manual.establishedSampleHash("samples/kick.wav");

    const replacement = replaceSample("samples/kick.wav", 0.9);
    manual.scan();

    const message = samplesChanged(await socket.next());
    expect(message.changed).toEqual(["samples/kick.wav"]);
    // The hash of the bytes now on disk, which is the key the engine's cache and the
    // worklet's configure check are both made of.
    expect(message.samples).toEqual([
      { path: "samples/hat.wav", contentHash: hashContent(sampleBytes("samples/hat.wav")) },
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
    ]);
    expect(manual.establishedSampleHash("samples/kick.wav")).toBe(hashContent(replacement));
    expect(manual.establishedSampleHash("samples/kick.wav")).not.toBe(before);
    // No document moved, so there is nothing else to say.
    await socket.expectSilence();
  });

  it("says nothing about a sample rewritten with the same bytes", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    // A copy over itself, a `touch`, a backup tool restoring an identical file: the
    // mtime moves and the content does not. Time is not an input here, so this is a
    // non-event — and an implementation that compared timestamps would push, and the
    // page would re-fetch and re-decode audio it already had on every such event.
    writeFileSync(join(root, "samples/kick.wav"), sampleBytes("samples/kick.wav"));
    manual.scan();

    await socket.expectSilence();
  });

  it("notices a replacement through the real filesystem watcher", async () => {
    // The one case that must use the real watcher: `samples/` was excluded by the event
    // filter, and no amount of driving `scan()` by hand would have caught that. Which
    // also means the disk has to be quiet first — any scan at all finds the replaced
    // sample, so a stray setup event arriving mid-test would make this pass with the
    // filter removed, which is exactly what it did before the drain went in. The filter
    // itself is proven on a fake clock in `watch.test.ts`; what this adds is that the
    // chain holds against the real operating system.
    const socket = await editorSocket();
    await untilTheSetupIsQuiet(socket);

    const replacement = replaceSample("samples/kick.wav", 0.5);

    const message = samplesChanged(await socket.next());
    expect(message.changed).toEqual(["samples/kick.wav"]);
    expect(message.samples.find((sample) => sample.path === "samples/kick.wav")?.contentHash).toBe(
      hashContent(replacement),
    );
  });

  it("reports an invalid replacement and adopts nothing, then announces the good one", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const good = manual.establishedSampleHash("samples/kick.wav");

    // A drag-and-drop of an MP3 renamed to .wav, or a half-written file. The validator
    // already refuses it (PCM WAV header, extension, 50 MB cap, existence), and this is
    // the case that proves a replacement gets exactly the treatment an invalid document
    // edit gets: keep the last good audio, name the file, adopt nothing.
    writeFileSync(join(root, "samples/kick.wav"), "ID3 this is not a wav at all", "utf8");
    manual.scan();

    const invalid = await socket.next();
    expect(invalid.type).toBe("projectInvalid");
    if (invalid.type !== "projectInvalid") return;
    const diagnostic = invalid.diagnostics.find((each) => each.code === "sample.not-wav");
    expect(diagnostic?.message).toContain("samples/kick.wav");
    // Nothing consumed, so the difference is still there to announce when it is fixed.
    expect(manual.establishedSampleHash("samples/kick.wav")).toBe(good);

    const replacement = replaceSample("samples/kick.wav", 0.75);
    manual.scan();

    expect(samplesChanged(await socket.next()).changed).toEqual(["samples/kick.wav"]);
    expect(manual.establishedSampleHash("samples/kick.wav")).toBe(hashContent(replacement));
    // The retraction of the diagnostics still arrives, with no documents in it: a
    // sample announcement is not a statement about whether the project validates.
    const retraction = changed(await socket.next());
    expect(retraction.changed).toEqual([]);
    expect(retraction.diagnostics.filter((each) => each.severity === "error")).toEqual([]);
  });

  it("reports a deleted sample a kit voice still names as an invalid project", async () => {
    // Verified rather than assumed: a missing sample is `sample.missing` from
    // `semanticValidate`, so it needs no special case here — it is an invalid project
    // like any other, and the last good audio keeps playing.
    const manual = manualSync();
    const socket = await editorSocket();
    const before = manual.establishedSampleHash("samples/kick.wav");

    unlinkSync(join(root, "samples/kick.wav"));
    manual.scan();

    const invalid = await socket.next();
    expect(invalid.type).toBe("projectInvalid");
    if (invalid.type !== "projectInvalid") return;
    expect(invalid.diagnostics.map((each) => each.code)).toContain("sample.missing");
    expect(manual.establishedSampleHash("samples/kick.wav")).toBe(before);
  });

  it("says nothing about a file dropped into samples/ that no instrument references", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    writeFileSync(join(root, "samples/spare.wav"), Buffer.from(encodeWav({ sampleRate: 8000, left: new Float32Array(10) }, 16)));
    manual.scan();

    // Nothing audible depends on it — the inventory is what the *instruments* name —
    // so there is nothing for a running engine to do about it.
    await socket.expectSilence();
  });

  it("announces a sample and a document edit from one settle window as two messages, samples first", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    // The composite case: an agent editing the drum pattern and dropping in a new kick
    // in the same breath. Samples go first, because the worklet refuses a graph naming
    // content it has not been sent.
    const replacement = replaceSample("samples/kick.wav", 0.6);
    externalEdit(
      "patterns/drums-verse.json",
      readFileSync(join(root, "patterns/drums-verse.json"), "utf8").replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"),
    );
    manual.scan();

    const samples = samplesChanged(await socket.next());
    expect(samples.changed).toEqual(["samples/kick.wav"]);
    expect(samples.samples.find((sample) => sample.path === "samples/kick.wav")?.contentHash).toBe(
      hashContent(replacement),
    );
    const documents = changed(await socket.next());
    expect(documents.changed.map((file) => file.path)).toEqual(["patterns/drums-verse.json"]);
    await socket.expectSilence();
  });

  it("keeps establishing a replaced sample with no browser connected", async () => {
    const manual = manualSync();
    const replacement = replaceSample("samples/kick.wav", 0.4);
    manual.scan();

    expect(manual.establishedSampleHash("samples/kick.wav")).toBe(hashContent(replacement));
  });

  it("refuses to establish a sample as document text", () => {
    // Unreachable through the write endpoint, which admits documents only. It is a
    // guard because the day sample writing is added, "documents are established as
    // text and samples as a content hash" is exactly the distinction that would be
    // missed — and the symptom would be the sidecar announcing its own write as
    // somebody else's edit.
    expect(() => sync.noteWrite("samples/kick.wav", "RIFF....")).toThrow(/content hash/);
    expect(() => sync.noteWrite("project.json", renamedProject("Fine"))).not.toThrow();
  });
});

describe("a reconnecting session's samples", () => {
  /**
   * The document inventory cannot answer this. A sample replaced while the socket was
   * down is established with nobody listening, so a page's *documents* can be exactly
   * in step with the disk — the quiet path through `catchUp` — while the audio it is
   * playing is a version behind. Without the hello carrying what the page holds, the
   * one case sample watching exists for survives a reconnect untouched.
   */
  it("tells a page holding stale sample content which file to fetch again", async () => {
    const manual = manualSync();
    replaceSample("samples/kick.wav", 0.8);
    manual.scan();

    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello({
      samples: [{ path: "samples/kick.wav", contentHash: "the-version-this-page-is-playing" }],
    });
    expect(await socket.next()).toMatchObject({ type: "welcome" });

    const message = samplesChanged(await socket.next());
    expect(message.changed).toEqual(["samples/kick.wav"]);
    expect(message.samples.find((sample) => sample.path === "samples/kick.wav")?.contentHash).toBe(
      manual.establishedSampleHash("samples/kick.wav"),
    );
  });

  it("says nothing to a page whose sample content is the content on disk", async () => {
    manualSync();
    const socket = new TestSocket(port);
    sockets.push(socket);

    await socket.hello({
      samples: [
        { path: "samples/kick.wav", contentHash: hashContent(sampleBytes("samples/kick.wav")) },
        { path: "samples/hat.wav", contentHash: hashContent(sampleBytes("samples/hat.wav")) },
      ],
    });

    expect(await socket.next()).toMatchObject({ type: "welcome" });
    await socket.expectSilence();
  });

  it("refuses a hello whose sample list is malformed", async () => {
    // Refused rather than ignored: a page whose declaration was silently dropped would
    // be told nothing about its stale audio, which is the failure the field prevents.
    const socket = new TestSocket(port);
    sockets.push(socket);

    await socket.hello({ samples: [{ path: "samples/kick.wav" }] });

    expect(await socket.next()).toMatchObject({ type: "error", message: expect.stringContaining("contentHash") });
    await socket.waitForClose();
    expect(sync.hasEditor).toBe(false);
  });
});

describe("writes bound to the session", () => {
  it("accepts a write from the browser that holds the session", async () => {
    const socket = await editorSocket();

    const response = await postWrite([{ path: "project.json", contents: renamedProject("From the holder") }], socket.writeSession);

    expect(response.status).toBe(200);
    expect(loadProject(root).project!.project.name).toBe("From the holder");
  });

  it("refuses a write from a window that was refused the session", async () => {
    const holder = await editorSocket();
    const second = new TestSocket(port);
    sockets.push(second);
    await second.hello();
    expect(await second.next()).toMatchObject({ type: "rejected" });
    expect(second.session).toBeUndefined();

    // The refused window has the page's token — it was served the same page — so
    // the token is not what stops it. Nothing but the session can.
    const response = await postWrite([{ path: "project.json", contents: renamedProject("From the second window") }], "not-the-session-id");

    expect(response.status).toBe(403);
    expect(response.body).toContain("another window");
    expect(loadProject(root).project!.project.name).not.toBe("From the second window");
    expect(holder.session).toBeDefined();
  });

  it("refuses a write that presents no session at all", async () => {
    await editorSocket();

    const response = await postWrite([{ path: "project.json", contents: renamedProject("No session") }], undefined);

    expect(response.status).toBe(403);
    expect(response.body).toContain("x-chord-garden-session");
    expect(loadProject(root).project!.project.name).not.toBe("No session");
  });

  it("refuses a write on a session id that has ended", async () => {
    const socket = await editorSocket();
    const stale = socket.writeSession;
    socket.dispose();
    for (let attempt = 0; attempt < 200 && sync.hasEditor; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sync.hasEditor).toBe(false);

    const response = await postWrite([{ path: "project.json", contents: renamedProject("After the socket went") }], stale);

    expect(response.status).toBe(403);
    expect(loadProject(root).project!.project.name).not.toBe("After the socket went");
  });

  it("mints a different session for the next window", async () => {
    const first = await editorSocket();
    const firstSession = first.writeSession;
    first.dispose();
    for (let attempt = 0; attempt < 200 && sync.hasEditor; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const second = await editorSocket();

    expect(second.writeSession).not.toBe(firstSession);
    expect((await postWrite([{ path: "project.json", contents: renamedProject("Old id") }], firstSession)).status).toBe(403);
    expect((await postWrite([{ path: "project.json", contents: renamedProject("New id") }], second.writeSession)).status).toBe(200);
  });
});

/** The inventory hash of the project as it stands, as a page would compute it. */
function currentInventory(): string {
  return inventoryHash(readSnapshot({ name: "p", root }).files);
}

/** Wait for the editor slot to be released, which the socket closing does. */
async function untilNoEditor(): Promise<void> {
  for (let attempt = 0; attempt < 200 && sync.hasEditor; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(sync.hasEditor).toBe(false);
}

/** GET a project path with the token, and optionally a session id. */
function get(path: string, session?: string): Promise<{ status: number; body: string }> {
  return rawRequest(port, path, { token: TOKEN, ...(session === undefined ? {} : { session }) });
}

describe("catching a reconnecting session up", () => {
  it("sends nothing to a page connecting for the first time", async () => {
    // A first connection carries no inventory, because the page holds nothing and
    // is about to load over HTTP. Pushing the bundle at it here would be a snapshot
    // it cannot use, on every page load.
    const socket = await editorSocket();

    await socket.expectSilence();
  });

  it("sends nothing to a session that reconnects in step with the disk", async () => {
    const manual = manualSync();
    const socket = new TestSocket(port);
    sockets.push(socket);

    await socket.hello({ inventory: currentInventory() });

    expect(await socket.next()).toMatchObject({ type: "welcome" });
    await socket.expectSilence();

    // And the session is a working one: the next edit arrives as an ordinary diff.
    externalEdit("project.json", renamedProject("After the reconnect"));
    manual.scan();
    const message = changed(await socket.next());
    expect(message.scope).toBe("diff");
    expect(message.changed.map((file) => file.path)).toEqual(["project.json"]);
  });

  it("sends a full snapshot to a session that reconnects behind the disk", async () => {
    const manual = manualSync();
    const stale = currentInventory();
    const first = await editorSocket();
    first.dispose();
    await untilNoEditor();

    // The edit nobody was listening for. The sidecar establishes it — it announces
    // differences from what it established, and there was nobody to tell — so a
    // reconnecting page would otherwise never hear about it.
    externalEdit("project.json", renamedProject("While you were away"));
    manual.scan();

    const second = new TestSocket(port);
    sockets.push(second);
    await second.hello({ inventory: stale });
    expect(await second.next()).toMatchObject({ type: "welcome" });

    const message = changed(await second.next());
    expect(message.scope).toBe("full");
    // Everything, not just the file that moved: the sidecar keeps no history, so
    // what it can honestly say is "here is the disk".
    expect(message.changed.map((file) => file.path)).toEqual(message.files.map((file) => file.path));
    expect(message.changed.find((file) => file.path === "project.json")!.text).toContain("While you were away");
    await second.expectSilence();
  });

  it("keeps owing the full snapshot until the disk validates again", async () => {
    const manual = manualSync();
    const stale = currentInventory();
    const pattern = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");
    externalEdit("project.json", renamedProject("Changed while nobody was here"));
    manual.scan();

    // The page comes back while an agent is mid-edit, so there is no snapshot to
    // hand it yet.
    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x"));
    const socket = new TestSocket(port);
    sockets.push(socket);
    await socket.hello({ inventory: stale });
    expect(await socket.next()).toMatchObject({ type: "welcome" });
    expect((await socket.next()).type).toBe("projectInvalid");

    // When the edit finishes, the catch-up it was owed is paid — in full, not as a
    // diff against a disk state this page never held.
    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"));
    manual.scan();

    const message = changed(await socket.next());
    expect(message.scope).toBe("full");
    expect(message.changed.map((file) => file.path)).toEqual(message.files.map((file) => file.path));
  });

  it("refuses a hello whose inventory is not a string", async () => {
    const socket = new TestSocket(port);
    sockets.push(socket);

    await socket.hello({ inventory: 17 });

    expect(await socket.next()).toMatchObject({ type: "error", message: expect.stringContaining("inventory") });
    await socket.waitForClose();
    expect(sync.hasEditor).toBe(false);
  });
});

describe("the snapshot endpoint and the watcher", () => {
  it("does not re-announce a snapshot it has served to the session holder", async () => {
    const manual = manualSync();
    const socket = await editorSocket();

    // An agent edit the watcher has not scanned yet, and then the holder loading the
    // project over HTTP — the ordinary reconnect-then-reload sequence.
    externalEdit("project.json", renamedProject("Read over HTTP"));
    const response = await get(`/api/projects/p/${SNAPSHOT_PATH}`, socket.writeSession);
    expect(response.status).toBe(200);
    expect(response.body).toContain("Read over HTTP");

    manual.scan();

    await socket.expectSilence();
    expect(manual.establishedText("project.json")).toContain("Read over HTTP");
  });

  it("still announces the edit when a snapshot was served without a session", async () => {
    // The engine harness page, a second window, `curl`. None of them is the editor,
    // so what they read says nothing about what the editor has seen — and treating
    // it as if it did would swallow this push and lose the agent's edit.
    const manual = manualSync();
    const socket = await editorSocket();

    externalEdit("project.json", renamedProject("Read by somebody else"));
    expect((await get(`/api/projects/p/${SNAPSHOT_PATH}`)).status).toBe(200);

    manual.scan();

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["project.json"]);
  });

  it("does not establish a snapshot that did not validate", async () => {
    const manual = manualSync();
    const socket = await editorSocket();
    const pattern = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");

    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x"));
    const response = await get(`/api/projects/p/${SNAPSHOT_PATH}`, socket.writeSession);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(false);

    // The browser could not have adopted that, so nothing about it is established:
    // when the edit finishes, the whole thing still arrives.
    externalEdit("patterns/drums-verse.json", pattern.replace("x..x ..x. x..x ..x.", "x..x ..x. x..x ..xx"));
    manual.scan();

    const message = changed(await socket.next());
    expect(message.changed.map((file) => file.path)).toEqual(["patterns/drums-verse.json"]);
    expect(manual.establishedText("patterns/drums-verse.json")).toContain("x..x ..x. x..x ..xx");
  });
});
