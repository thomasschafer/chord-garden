import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { loadProject } from "@chord-garden/format";
import type { ProjectSummary } from "./api.js";
import { resolveProjectAsset } from "./paths.js";

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
  log?: (line: string) => void;
}

const BUNDLE_FILES: Record<string, string> = {
  "/harness.js": "application/javascript; charset=utf-8",
  "/harness.js.map": "application/json; charset=utf-8",
  "/worklet.js": "application/javascript; charset=utf-8",
  "/worklet.js.map": "application/json; charset=utf-8",
};

/**
 * Read-only HTTP for one or more project bundles, plus the harness page.
 *
 * This is not the Phase 4 sidecar: it does not watch, write, hold a WebSocket or
 * authenticate. It is the *asset half* of that sidecar, with the URL shape the
 * sidecar's `openProject`/`readAsset` (PLAN.md §11) can adopt as-is — one mount
 * per open project, documents and samples behind the same confined `files/`
 * endpoint — so Phase 4 adds routes to this shape rather than replacing it.
 *
 * Everything it serves is reloaded per request. A dev server that caches a
 * project is a dev server that lies about what is on disk, and the agent editing
 * these files expects a reload to show its edit.
 */
export function createAssetServer(options: AssetServerOptions): Server {
  const log = options.log ?? (() => {});
  const mounts = new Map(options.projects.map((project) => [project.name, project]));

  return createServer((req, res) => {
    try {
      handle(req, res, mounts, options, log);
    } catch (error) {
      // Never let a request handler take the process down: the browser is
      // mid-session and a 500 with the reason is far more useful than a dead port.
      const message = error instanceof Error ? error.message : String(error);
      log(`500 ${req.method ?? "?"} ${req.url ?? "?"} ${message}`);
      sendText(res, 500, message);
    }
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  mounts: Map<string, ProjectMount>,
  options: AssetServerOptions,
  log: (line: string) => void,
): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, `this server is read-only; ${method} is not accepted`);
    return;
  }
  if (!hostIsLoopback(req.headers.host)) {
    // PLAN.md §10: bound to loopback, so a request arriving under any other name
    // reached us through something rebinding DNS at us.
    sendText(res, 403, `refusing request for host "${String(req.headers.host)}"; this server is loopback-only`);
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  log(`${method} ${path}`);

  if (path === "/" || path === "/index.html") {
    sendFile(res, join(options.webRoot, "index.html"), "text/html; charset=utf-8", method);
    return;
  }
  const bundleType = BUNDLE_FILES[path];
  if (bundleType !== undefined) {
    sendFile(res, join(options.bundleRoot, path.slice(1)), bundleType, method, {
      missing: "the web bundles are not built; run `npm run build`",
    });
    return;
  }
  if (path === "/api/projects") {
    sendJson(res, 200, { projects: [...mounts.values()].map((mount) => ({ name: mount.name, root: mount.root })) }, method);
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

/**
 * Load and validate a project for the browser. The browser gets each document's
 * resolved kind so it can index the bundle without re-running the schema
 * validation this side has just done.
 */
export function summarise(mount: ProjectMount): ProjectSummary {
  const result = loadProject(mount.root);
  return {
    name: mount.name,
    root: mount.root,
    ok: result.ok,
    files: [...result.files.values()]
      .map((file) => ({ path: file.path, kind: file.kind }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      file: diagnostic.file,
      message: diagnostic.message,
    })),
  };
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  // Strip the port; an IPv6 literal keeps its brackets.
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
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
