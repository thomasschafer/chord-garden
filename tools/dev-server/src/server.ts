import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { loadProject } from "@chord-garden/format";
import { hashContent } from "@chord-garden/engine/live";
import {
  MAX_SOCKET_MESSAGE_BYTES,
  SESSION_HEADER,
  SNAPSHOT_PATH,
  SOCKET_PATH,
  TOKEN_GLOBAL,
  TOKEN_HEADER,
  WRITE_SESSION_STATUS,
  type ProjectSnapshot,
  type ProjectSummary,
  type WriteRequest,
  type WriteResponse,
} from "./api.js";
import { resolveProjectAsset, resolveStaticAsset } from "./paths.js";
import type { ProjectSync } from "./sync.js";
import { constantTimeEquals } from "./token.js";
import { acceptUpgrade, refuseUpgrade } from "./websocket.js";
import { MAX_BODY_BYTES, writeBatch } from "./write.js";

/** One project directory, exposed under `/api/projects/<name>`. */
export interface ProjectMount {
  name: string;
  /** Absolute path to the project bundle's root directory. */
  root: string;
}

export interface AssetServerOptions {
  projects: readonly ProjectMount[];
  /** Directory holding `index.html`. */
  webRoot: string;
  /** Directory holding the built `harness.js` / `worklet.js`. */
  bundleRoot: string;
  /**
   * Session token required on every `/api` request (PLAN.md §10). Not optional,
   * and not defaulted: a server that will accept an unauthenticated write
   * because nobody passed a token is the bug this type exists to prevent.
   */
  token: string;
  /** Directory holding the built web app (`app/dist`), served under `/app/`. */
  appRoot?: string;
  /**
   * The watcher/push layer for each project, by mount name (PLAN.md §12). When a
   * project has one, `/api/projects/<name>/socket` upgrades to its WebSocket, every
   * write through this server is reported to it for echo detection, and every write
   * must present the read-write session id it minted (PLAN.md §12's single-writer
   * rule, enforced on the disk rather than only on the socket). A project without
   * one has no sessions to hold, and is served exactly as before — which is what
   * the harness page and the read-only tests want.
   *
   * Constructed by the caller rather than here so that the thing which decides
   * *when* a scan happens can be replaced in a test without stubbing an HTTP
   * server, and so the sidecar's lifetime is owned by whoever owns the process.
   */
  syncs?: ReadonlyMap<string, ProjectSync>;
  log?: (line: string) => void;
}

const BUNDLE_FILES: Record<string, string> = {
  "/harness.js": "application/javascript; charset=utf-8",
  "/harness.js.map": "application/json; charset=utf-8",
  "/worklet.js": "application/javascript; charset=utf-8",
  "/worklet.js.map": "application/json; charset=utf-8",
};

/**
 * HTTP for one or more project bundles, the harness page, and the web app.
 *
 * This is not the Phase 4 sidecar: it does not watch the filesystem or hold a
 * WebSocket. It is the *asset and write half* of that sidecar, with the URL
 * shape the sidecar's `openProject`/`readAsset`/`writeFile` (PLAN.md §11) can
 * adopt as-is — one mount per open project, documents and samples behind the
 * same confined `files/` endpoint, a batched `write` endpoint beside them — so
 * Phase 4 adds routes to this shape rather than replacing it.
 *
 * Security, per PLAN.md §10, is applied here rather than retrofitted: loopback
 * `Host`, same-origin `Origin`, a session token on every `/api` request, path
 * confinement on reads and (more narrowly) on writes, and body size limits. The
 * HTML pages themselves are unauthenticated — a browser cannot put a header on a
 * navigation — and carry the token to their own scripts instead.
 *
 * Everything it serves is reloaded per request. A dev server that caches a
 * project is a dev server that lies about what is on disk, and the agent editing
 * these files expects a reload to show its edit.
 */
export function createAssetServer(options: AssetServerOptions): Server {
  const log = options.log ?? (() => {});
  const mounts = new Map(options.projects.map((project) => [project.name, project]));
  if (options.token.length < 16) {
    throw new Error(`session token must be at least 16 characters; got ${options.token.length}`);
  }

  const server = createServer((req, res) => {
    try {
      const finished = handle(req, res, mounts, options, log);
      if (finished instanceof Promise) {
        finished.catch((error: unknown) => {
          fail(req, res, log, error);
        });
      }
    } catch (error) {
      fail(req, res, log, error);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head, mounts, options, log);
    } catch (error) {
      log(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    }
  });

  return server;
}

/**
 * Turn an upgrade request into a sync socket, or refuse it.
 *
 * The same three gates as an HTTP request, in the same order, because a
 * WebSocket is not less dangerous than a GET (PLAN.md §10): loopback `Host`,
 * matching `Origin`, and confinement to a project that is actually mounted. The
 * token is the one difference — it arrives in the socket's first message rather
 * than in a header or a query parameter, so `ProjectSync` completes the
 * authentication after this function has handed the socket over.
 */
function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  mounts: Map<string, ProjectMount>,
  options: AssetServerOptions,
  log: (line: string) => void,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = new RegExp(`^/api/projects/([^/]+)/${SOCKET_PATH}$`).exec(url.pathname);
  if (match === null) {
    log(`404 upgrade ${url.pathname}`);
    refuseUpgrade(socket, { status: 404, message: `no socket at ${url.pathname}` });
    return;
  }
  const name = decodeURIComponent(match[1]!);
  const sync = options.syncs?.get(name);
  if (sync === undefined || !mounts.has(name)) {
    log(`404 upgrade ${url.pathname}`);
    refuseUpgrade(socket, {
      status: 404,
      message: mounts.has(name)
        ? `project "${name}" is served without a watcher, so it has no sync socket`
        : `no project named "${name}"`,
    });
    return;
  }

  const connection = acceptUpgrade(req, socket, {
    maxMessageBytes: MAX_SOCKET_MESSAGE_BYTES,
    check: (request) => {
      if (!hostIsLoopback(request.headers.host)) {
        return { status: 403, message: `refusing upgrade for host "${String(request.headers.host)}"` };
      }
      const originError = checkOrigin(request);
      return originError === undefined ? undefined : { status: 403, message: originError };
    },
  });
  if (connection === undefined) return;

  log(`upgrade ${url.pathname}`);
  sync.attach(connection);
  if (head.length > 0) connection.ingest(head);
}

/**
 * Never let a request handler take the process down: the browser is mid-session
 * and a 500 with the reason is far more useful than a dead port.
 */
function fail(req: IncomingMessage, res: ServerResponse, log: (line: string) => void, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log(`500 ${req.method ?? "?"} ${req.url ?? "?"} ${message}`);
  if (!res.headersSent) sendText(res, 500, message);
  else res.end();
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  mounts: Map<string, ProjectMount>,
  options: AssetServerOptions,
  log: (line: string) => void,
): void | Promise<void> {
  const method = req.method ?? "GET";
  if (!hostIsLoopback(req.headers.host)) {
    // PLAN.md §10: bound to loopback, so a request arriving under any other name
    // reached us through something rebinding DNS at us.
    sendText(res, 403, `refusing request for host "${String(req.headers.host)}"; this server is loopback-only`);
    return;
  }
  const originError = checkOrigin(req);
  if (originError !== undefined) {
    log(`403 ${method} ${req.url ?? "?"} ${originError}`);
    sendText(res, 403, originError);
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  log(`${method} ${path}`);

  // Pages and bundles are navigations and script loads: a browser cannot attach
  // a token header to either, so they are unauthenticated by necessity. They
  // contain no project data; the token they hand to the page guards that.
  if (method === "GET" || method === "HEAD") {
    if (path === "/" || path === "/index.html") {
      sendHtml(res, join(options.webRoot, "index.html"), options.token, method);
      return;
    }
    const bundleType = BUNDLE_FILES[path];
    if (bundleType !== undefined) {
      sendFile(res, join(options.bundleRoot, path.slice(1)), bundleType, method, {
        missing: "the web bundles are not built; run `npm run build`",
      });
      return;
    }
    if (path === "/app" || path === "/app/" || path === "/app/index.html") {
      if (options.appRoot === undefined) {
        sendText(res, 404, "this server was started without an app build; run `npm run build`");
        return;
      }
      sendHtml(res, join(options.appRoot, "index.html"), options.token, method, {
        missing: "the web app is not built; run `npm run build -w @chord-garden/app`",
      });
      return;
    }
    if (path.startsWith("/app/")) {
      if (options.appRoot === undefined) {
        sendText(res, 404, "this server was started without an app build; run `npm run build`");
        return;
      }
      const asset = resolveStaticAsset(options.appRoot, path.slice("/app/".length));
      if (!asset.ok) {
        sendText(res, asset.status, asset.message);
        return;
      }
      sendFile(res, asset.path, asset.contentType, method);
      return;
    }
  }

  if (!path.startsWith("/api/")) {
    sendText(res, method === "GET" || method === "HEAD" ? 404 : 405, `no route for ${method} ${path}`);
    return;
  }

  // Everything below touches a project. PLAN.md §10: the token is required on
  // every one of these, read or write.
  const token = header(req, TOKEN_HEADER);
  if (token === undefined || !constantTimeEquals(token, options.token)) {
    log(`401 ${method} ${path} ${token === undefined ? "no token" : "wrong token"}`);
    sendText(res, 401, `this endpoint needs the session token in the ${TOKEN_HEADER} header`);
    return;
  }

  const write = /^\/api\/projects\/([^/]+)\/write$/.exec(path);
  if (write !== null) {
    if (method !== "POST") {
      sendText(res, 405, `the write endpoint takes POST, not ${method}`);
      return;
    }
    const missingOrigin = requireOrigin(req);
    if (missingOrigin !== undefined) {
      log(`403 ${method} ${path} ${missingOrigin}`);
      sendText(res, 403, missingOrigin);
      return;
    }
    const mount = mounts.get(decodeURIComponent(write[1]!));
    if (mount === undefined) {
      sendText(res, 404, `no project named "${decodeURIComponent(write[1]!)}"`);
      return;
    }
    const sync = options.syncs?.get(mount.name);
    const refusal = sync === undefined ? undefined : checkSession(req, sync, mount.name);
    if (refusal !== undefined) {
      log(`${WRITE_SESSION_STATUS} ${method} ${path} ${refusal}`);
      sendText(res, WRITE_SESSION_STATUS, refusal);
      return;
    }
    return handleWrite(req, res, mount, sync, log);
  }

  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, `${path} is read-only; ${method} is not accepted`);
    return;
  }

  if (path === "/api/projects") {
    sendJson(res, 200, { projects: [...mounts.values()].map((mount) => ({ name: mount.name, root: mount.root })) }, method);
    return;
  }

  const snapshot = new RegExp(`^/api/projects/([^/]+)/${SNAPSHOT_PATH}$`).exec(path);
  if (snapshot !== null) {
    const name = decodeURIComponent(snapshot[1]!);
    const mount = mounts.get(name);
    if (mount === undefined) {
      sendText(res, 404, `no project named "${name}"`);
      return;
    }
    const body = readSnapshot(mount);
    // Establishing what was served is only correct for the browser that holds the
    // read-write session, and only for a snapshot that validated — see
    // `ProjectSync.noteServed`. Done before the response is written, in the same
    // synchronous block as the read, so no scan can slip between them.
    const sync = options.syncs?.get(name);
    const session = header(req, SESSION_HEADER);
    if (sync !== undefined && body.ok && session !== undefined && sync.holdsSession(session)) {
      sync.noteServed(body.files);
    }
    sendJson(res, 200, body, method);
    return;
  }

  const api = /^\/api\/projects\/([^/]+)(?:\/files\/(.*))?$/.exec(path);
  if (api === null) {
    sendText(res, 404, `no route for ${path}`);
    return;
  }
  const name = decodeURIComponent(api[1]!);
  const mount = mounts.get(name);
  if (mount === undefined) {
    sendText(res, 404, `no project named "${name}"; serving ${[...mounts.keys()].join(", ") || "nothing"}`);
    return;
  }
  const requested = api[2];
  if (requested === undefined) {
    sendJson(res, 200, summarise(mount), method);
    return;
  }

  const asset = resolveProjectAsset(mount.root, requested);
  if (!asset.ok) {
    log(`${asset.status} ${path} ${asset.message}`);
    sendText(res, asset.status, asset.message);
    return;
  }
  sendFile(res, asset.path, asset.contentType, method);
}

/** Read, validate and persist a write batch, then report the project's state. */
async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  mount: ProjectMount,
  sync: ProjectSync | undefined,
  log: (line: string) => void,
): Promise<void> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    sendText(res, 415, `write batches are application/json, not "${type}"`);
    return;
  }

  const read = await readBody(req);
  if (!read.ok) {
    log(`${read.status} write ${mount.name} ${read.message}`);
    sendText(res, read.status, read.message);
    return;
  }
  const body = read.text;

  let request: WriteRequest;
  try {
    request = JSON.parse(body) as WriteRequest;
  } catch (error) {
    sendText(res, 400, `write batch is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (request === null || typeof request !== "object" || !Array.isArray(request.files)) {
    sendText(res, 400, 'write batch must be an object with a "files" array');
    return;
  }
  const deletes = request.deletes ?? [];
  if (!Array.isArray(deletes)) {
    sendText(res, 400, 'a write batch\'s "deletes" must be an array if present');
    return;
  }

  const result = writeBatch(
    mount.root,
    request.files,
    {
      written: (path, contents) => sync?.noteWrite(path, contents),
      removed: (path) => sync?.noteRemoval(path),
    },
    deletes,
  );
  if (!result.ok) {
    log(`${result.status} write ${mount.name} ${result.message}`);
    sendText(res, result.status, result.message);
    return;
  }
  log(
    `wrote ${result.acks.map((ack) => ack.path).join(", ") || "nothing"} in ${mount.name}${
      result.removed.length > 0 ? `, removed ${result.removed.join(", ")}` : ""
    }`,
  );
  const response: WriteResponse = {
    ok: true,
    written: result.acks,
    removed: result.removed,
    summary: summarise(mount),
  };
  sendJson(res, 200, response);
}

/**
 * How much of an over-limit upload to read and throw away so that the refusal
 * can be delivered on a healthy connection, and how long to spend doing it.
 * Past either bound the connection is dropped and the caller sees a transport
 * error rather than a 413 — the honest outcome for someone still sending eight
 * megabytes after being told the limit is one.
 */
const DRAIN_LIMIT_BYTES = 8 * MAX_BODY_BYTES;
const DRAIN_TIMEOUT_MS = 2000;

type BodyResult = { ok: true; text: string } | { ok: false; status: 400 | 413; message: string };

/**
 * Collect a request body, refusing anything over the batch limit.
 *
 * The subtle part is *when* the refusal is sent. Responding the moment the limit
 * is crossed races the client, which is still writing: the server stops reading,
 * the socket buffer fills, and the client's next write fails with ECONNRESET
 * before it ever reads the 413. That race is load-dependent, which makes it a
 * flaky test rather than an honest one.
 *
 * So an over-limit body is drained to completion first — read and discarded, not
 * buffered, so memory stays bounded by `MAX_BODY_BYTES` either way — and the 413
 * goes out afterwards, on a connection with nothing left in flight. Draining is
 * itself bounded by `DRAIN_LIMIT_BYTES` and `DRAIN_TIMEOUT_MS`, so "keep sending
 * and I will keep listening" cannot become the resource exhaustion the limit
 * exists to prevent.
 */
function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;

    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      req.destroy();
      settle({
        ok: false,
        status: 413,
        message: `write batch passed the ${MAX_BODY_BYTES}-byte limit and did not finish sending`,
      });
    }, DRAIN_TIMEOUT_MS);
    timer.unref();

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Past the limit nothing more is kept: this body is going to be refused,
        // and the only reason to go on reading is to let the refusal land.
        overLimit = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
      if (total > DRAIN_LIMIT_BYTES) {
        req.destroy();
        settle({
          ok: false,
          status: 413,
          message: `write batch is at least ${total} bytes, far past the ${MAX_BODY_BYTES}-byte limit`,
        });
      }
    });
    req.on("end", () => {
      settle(
        overLimit
          ? { ok: false, status: 413, message: `write batch is ${total} bytes, more than the ${MAX_BODY_BYTES}-byte limit` }
          : { ok: true, text: Buffer.concat(chunks).toString("utf8") },
      );
    });
    req.on("error", (error) => {
      settle({ ok: false, status: 400, message: `could not read the write batch: ${error.message}` });
    });
  });
}

/**
 * Load and validate a project, with every document's bytes, from one read of the
 * disk (PLAN.md §12).
 *
 * One `loadProject` per response is the point, not an optimisation: a browser that
 * assembled its model from several reads could be handed two halves of two
 * different disk states, and the resulting model is one no validation ever passed.
 * The bytes returned are the exact bytes that were validated — `loadProject` keeps
 * them for this reason — rather than a re-read or a re-serialization, so the
 * browser's write preconditions are made of what the server actually saw.
 */
export function readSnapshot(mount: ProjectMount): ProjectSnapshot {
  const result = loadProject(mount.root);
  return {
    name: mount.name,
    root: mount.root,
    ok: result.ok,
    files: [...result.files.values()]
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        contentHash: hashContent(Buffer.from(file.text, "utf8")),
        text: file.text,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      file: diagnostic.file,
      message: diagnostic.message,
    })),
  };
}

/**
 * The same project without the document bytes: what a caller that only needs to
 * know the shape of the bundle and its diagnostics gets. Derived from
 * `readSnapshot` rather than loading again, so the two cannot describe different
 * disks.
 */
export function summarise(mount: ProjectMount): ProjectSummary {
  const snapshot = readSnapshot(mount);
  return {
    name: snapshot.name,
    root: snapshot.root,
    ok: snapshot.ok,
    files: snapshot.files.map((file) => ({ path: file.path, kind: file.kind })),
    diagnostics: snapshot.diagnostics,
  };
}

/**
 * Refuse a write that does not hold the project's read-write session (PLAN.md §12).
 *
 * The socket refuses a second window, which stops it *hearing* about the disk; on
 * its own that leaves the window able to write to it. So a write must present the
 * session id the sidecar minted for the browser it admitted. Both refusals name
 * what to do, because both are states a person can be sitting in front of: a second
 * window that should be closed, and a page whose socket dropped and is reconnecting.
 */
function checkSession(req: IncomingMessage, sync: ProjectSync, name: string): string | undefined {
  const session = header(req, SESSION_HEADER);
  if (session === undefined) {
    return `a write to "${name}" needs the ${SESSION_HEADER} header carrying the session id from the sync socket's welcome message`;
  }
  if (!sync.holdsSession(session)) {
    return `this window does not hold the write session for "${name}": either the project is open in another window, or this page's sync socket dropped and it must reconnect before writing`;
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const presented = req.headers[name];
  return Array.isArray(presented) ? presented[0] : presented;
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  // Strip the port; an IPv6 literal keeps its brackets.
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * PLAN.md §10's Origin check, expressed without configuration.
 *
 * Everything this server hands a browser it also serves, so a legitimate request
 * from one of its own pages carries either no `Origin` (browsers omit it on
 * same-origin GETs) or an `Origin` that is exactly `http://` plus this request's
 * own `Host`. Deriving the expected value from `Host` rather than from a
 * configured port is what lets it hold when the port is chosen at listen time,
 * and `Host` has already been forced to a loopback name above.
 *
 * Absence is tolerated here and refused at the write route (`requireOrigin`):
 * every browser sends `Origin` on a POST, so a write without one did not come
 * from a page, while a read without one is the ordinary same-origin GET.
 */
function checkOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  const expected = `http://${String(req.headers.host)}`;
  if (origin !== expected) {
    return `refusing request from origin "${origin}"; this server only accepts "${expected}"`;
  }
  return undefined;
}

/** The stricter half of the Origin rule, for requests that change the disk. */
function requireOrigin(req: IncomingMessage): string | undefined {
  return req.headers.origin === undefined
    ? "a write needs an Origin header; this server only accepts writes from its own pages"
    : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, method = "GET"): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : text);
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    "cache-control": "no-store",
  });
  res.end(message);
}

/**
 * Serve an HTML page with the session token injected as a global.
 *
 * The page cannot be asked for a header on a navigation, so this is how the
 * token reaches the code that needs it. It is safe against a hostile page in
 * another tab: that page cannot read a cross-origin HTML response, and the
 * Origin check above rejects its requests even if it somehow could.
 */
function sendHtml(
  res: ServerResponse,
  path: string,
  token: string,
  method: string,
  options: { missing?: string } = {},
): void {
  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    sendText(res, 404, options.missing ?? `${path} is missing`);
    return;
  }
  const inject = `<script>window.${TOKEN_GLOBAL} = ${JSON.stringify(token)};</script>`;
  const head = html.indexOf("<head>");
  if (head < 0) throw new Error(`${path} has no <head> to inject the session token into`);
  const injected = html.slice(0, head + "<head>".length) + inject + html.slice(head + "<head>".length);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(injected),
    "cache-control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : injected);
}

function sendFile(
  res: ServerResponse,
  path: string,
  contentType: string,
  method: string,
  options: { missing?: string } = {},
): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    sendText(res, 404, options.missing ?? `${path} is missing`);
    return;
  }
  res.writeHead(200, { "content-type": contentType, "content-length": size, "cache-control": "no-store" });
  if (method === "HEAD") {
    res.end();
    return;
  }
  // Small files, but streaming keeps a 100 MB sample from being buffered whole.
  createReadStream(path).pipe(res);
}
