import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject, serializeCanonical } from "@chord-garden/format";
import { SESSION_TOKEN_PATH } from "../src/api.js";
import { ProjectClient } from "../src/client.js";
import { createAssetServer } from "../src/server.js";
import { ProjectSocket, type SyncRejection, type SyncTransportFactory } from "../src/socket.js";
import { ProjectSync } from "../src/sync.js";
import { hashOnDisk } from "../src/write.js";
import { rawRequest } from "./helpers.js";

/**
 * Restarting the sidecar under an open page (PLAN.md §10: the token is minted per
 * run).
 *
 * The session token is regenerated on every start, so a page that was open across a
 * restart offers a token the new sidecar has never heard of. That used to be
 * reported as `the session token is missing or wrong` and treated as final: the UI
 * was replaced wholesale by a security notice, and every edit the page had not yet
 * written — the ones it had just promised were "kept and will be written when the
 * connection returns" — went with it. A restart is not a security event and must not
 * cost anybody their work.
 *
 * These drive the real client against a real server over a real socket, because the
 * bug lived exactly in the seam between them: each half was defensible on its own.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const FIRST_TOKEN = "first-run-token-0123456789abcdef";
const SECOND_TOKEN = "second-run-token-fedcba9876543210";

let root: string;
let server: Server | undefined;
let sync: ProjectSync | undefined;
let port = 0;
let socket: ProjectSocket | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chord-garden-restart-")));
  cpSync(FIXTURE, root, { recursive: true });
  // A fresh port per test, but the *same* port across a restart within one. Node's
  // HTTP agent pools keep-alive sockets by host and port, so carrying a port from
  // one test to the next hands the next request a connection to a server that has
  // since closed, and it fails as a hang-up rather than as whatever it was checking.
  port = 0;
});

afterEach(async () => {
  socket?.close();
  socket = undefined;
  await stop();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Start a sidecar on `port`, or on a fresh port when there is not one yet.
 *
 * Listening again on the same port is what makes this a *restart* rather than a
 * different server: the page can only ever reach the origin that served it, and
 * that is the whole reason a refused token means "restarted" rather than "not
 * welcome here".
 */
async function start(token: string): Promise<void> {
  sync = new ProjectSync({ mount: { name: "p", root }, token, watchFilesystem: false });
  const syncs = new Map([["p", sync]]);
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token,
    syncs,
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(port, "127.0.0.1", resolve));
  port = (listening.address() as AddressInfo).port;
}

async function stop(): Promise<void> {
  sync?.close();
  sync = undefined;
  const listening = server;
  server = undefined;
  if (listening === undefined) return;
  await new Promise<void>((resolve, reject) => {
    listening.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Wait until `condition` holds, or fail saying what never happened. */
async function until(what: string, condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The app's transport, over Node's own WebSocket client. */
const transport: SyncTransportFactory = (path, handlers) => {
  const connection = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  connection.addEventListener("open", () => handlers.open());
  connection.addEventListener("message", (event: MessageEvent) => handlers.text(String(event.data)));
  connection.addEventListener("close", (event: CloseEvent) => handlers.closed(event.code, event.reason));
  connection.addEventListener("error", () => handlers.failed("the sync socket failed"));
  return {
    send: (text) => connection.send(text),
    close: () => connection.close(),
  };
};

interface Session {
  client: ProjectClient;
  socket: ProjectSocket;
  ready: boolean[];
  rejected: SyncRejection[];
  dropped: string[];
}

/** A page: the HTTP client and the sync socket, wired together as the app wires them. */
function page(options: { refreshable?: boolean } = {}): Session {
  const client = new ProjectClient(FIRST_TOKEN, `http://127.0.0.1:${port}`);
  const ready: boolean[] = [];
  const rejected: SyncRejection[] = [];
  const dropped: string[] = [];
  const opened = new ProjectSocket({
    project: "p",
    token: client.sessionToken,
    factory: transport,
    retryDelaysMs: [10],
    ...(options.refreshable === false ? {} : { refreshToken: () => client.refreshToken() }),
    handlers: {
      ready: (reconnected) => ready.push(reconnected),
      changed: () => {},
      samplesChanged: () => {},
      invalid: () => {},
      rejected: (rejection) => rejected.push(rejection),
      dropped: (reason) => dropped.push(reason),
      protocolError: () => {},
    },
  });
  client.useSession(() => opened.session);
  socket = opened;
  return { client, socket: opened, ready, rejected, dropped };
}

/** project.json with a different name, canonically serialized: an ordinary edit. */
function renamedProject(name: string): string {
  const result = loadProject(root);
  const doc = structuredClone(result.project!.project);
  doc.name = name;
  return serializeCanonical(doc as never, "project");
}

/** A write as the page would send it, with the token and session it holds now. */
function postWrite(token: string, session: string, contents: string): Promise<{ status: number; body: string }> {
  return rawRequest(port, "/api/projects/p/write", {
    method: "POST",
    body: JSON.stringify({ files: [{ path: "project.json", contents, expectedHash: hashOnDisk(join(root, "project.json")) }] }),
    token,
    session,
    origin: `http://127.0.0.1:${port}`,
  });
}

describe("a sidecar restart under an open page", () => {
  it("re-authenticates and keeps the session rather than refusing the window", async () => {
    await start(FIRST_TOKEN);
    const session = page();
    session.socket.connect();
    await until("the first connection to be welcomed", () => session.ready.length === 1);
    const firstSession = session.socket.session;
    expect(firstSession).toBeDefined();

    // The restart. Same port, new token — exactly what `chord-garden-dev` does when
    // it is stopped and started again.
    await stop();
    await start(SECOND_TOKEN);

    // No human intervention, no reload: the page notices, is refused for holding the
    // old token, fetches the current one and hands the handshake back.
    await until("the page to re-authenticate and be welcomed again", () => session.ready.length === 2);

    // `reconnected` is true, which is the signal the app flushes its unsaved edits
    // on — the edits that used to be lost here.
    expect(session.ready).toEqual([false, true]);
    // And, decisively, this is not reported as a refusal. A refusal replaces the
    // whole UI with an error and there is nothing left to flush into.
    expect(session.rejected).toEqual([]);
    expect(session.socket.session).toBeDefined();
    expect(session.socket.session).not.toBe(firstSession);
    expect(session.dropped.join(" ")).toContain("restarted");
  });

  it("can write again afterwards, with the token and session the restart minted", async () => {
    await start(FIRST_TOKEN);
    const session = page();
    session.socket.connect();
    await until("the first connection to be welcomed", () => session.ready.length === 1);

    await stop();
    await start(SECOND_TOKEN);
    await until("the page to re-authenticate", () => session.ready.length === 2);

    // The point of keeping the session: the write that was pending across the
    // restart can actually land. Both credentials had to be replaced for this — the
    // token the client sends and the session id the socket minted — which is why the
    // refresh goes through `ProjectClient` rather than being fetched in the socket.
    const written = await postWrite(session.client.sessionToken, session.socket.session!, renamedProject("Survived the restart"));
    expect(written.status).toBe(200);
    expect(readFileSync(join(root, "project.json"), "utf8")).toContain("Survived the restart");
    expect(session.client.sessionToken).toBe(SECOND_TOKEN);
  });

  it("still refuses a page that has no way to come by the current token", async () => {
    // The bound on all of this. A client with no `refreshToken` — anything that is
    // not one of this sidecar's own pages — gets the old terminal refusal, because
    // there is nothing better to do for it.
    await start(FIRST_TOKEN);
    const session = page({ refreshable: false });
    session.socket.connect();
    await until("the first connection to be welcomed", () => session.ready.length === 1);

    await stop();
    await start(SECOND_TOKEN);

    await until("the page to be refused", () => session.rejected.length === 1);
    expect(session.rejected[0]?.kind).toBe("refused");
    expect(session.ready).toEqual([false]);
  });
});

describe("the endpoint a restarted page asks for the current token", () => {
  it("answers any loopback requester, which is what the served pages already do", async () => {
    await start(FIRST_TOKEN);

    // No token, no session, no Origin — a bare `curl`. This is not a new hole: the
    // reviewer's own check was `curl http://127.0.0.1:PORT/app/ | grep`, and the
    // page hands the same value over. Verified here so the claim that the token is a
    // session handle rather than a security control stays true by test rather than
    // by memory.
    const answered = await rawRequest(port, SESSION_TOKEN_PATH);
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ token: FIRST_TOKEN });

    const fromPage = await rawRequest(port, "/app/");
    // The app build may not be present in a bare checkout; when it is, it carries
    // the same token this endpoint hands out.
    if (fromPage.status === 200) expect(fromPage.body).toContain(FIRST_TOKEN);
  });

  it("is refused for a non-loopback host and for another origin, like everything else here", async () => {
    await start(FIRST_TOKEN);

    // The checks that actually defend this server (PLAN.md §10), applied to this
    // endpoint by the same code path as to the pages.
    const rebound = await rawRequest(port, SESSION_TOKEN_PATH, { host: "attacker.example.com" });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain(FIRST_TOKEN);

    const crossOrigin = await rawRequest(port, SESSION_TOKEN_PATH, { origin: "http://evil.example.com" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).not.toContain(FIRST_TOKEN);
  });
});
