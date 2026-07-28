import { realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ID_PATTERN } from "@chord-garden/format/pure";

/**
 * File extensions a project bundle is made of. An allowlist rather than a
 * denylist: this endpoint exists to hand the browser documents and samples, and
 * anything else that ends up inside a project directory (an editor swap file, a
 * key someone dropped there) is not ours to serve.
 */
const SERVABLE: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
};

/** Subdirectories that hold one document per object (PLAN.md §4). */
const DOC_DIRS = new Set(["tracks", "instruments", "patterns", "automation"]);

/** Root-level documents. Anything else at the root is not ours to write. */
const ROOT_DOCS = new Set(["project.json", "arrangement.json"]);

export type ResolvedAsset = { ok: true; path: string; contentType: string };
export type RejectedAsset = { ok: false; status: 400 | 403 | 404; message: string };

export type ResolvedWrite = {
  ok: true;
  path: string;
  relative: string;
  /**
   * A document directory that does not exist yet and would have to be created
   * for this write to land, or `undefined` when the parent is already there.
   *
   * Reported rather than created, because resolving a path is something a
   * *rejected* batch also does. The caller creates these only once every
   * precondition in the batch has passed, so a 409 leaves the disk exactly as
   * it found it.
   */
  missingParent: string | undefined;
};
export type RejectedWrite = { ok: false; status: 400 | 403; message: string };

/** Media type for a project-relative path, or undefined if it is not servable. */
export function contentTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : SERVABLE[path.slice(dot).toLowerCase()];
}

type ParsedPath = { ok: true; decoded: string; segments: string[] } | { ok: false; status: 400 | 403; message: string };

/**
 * Decode a still-encoded request path into project-relative segments, or refuse.
 *
 * Shared by reads and writes so the two cannot disagree about what a path even
 * is: a traversal the read endpoint rejects must not be spellable in a way the
 * write endpoint accepts.
 */
function parseRelativePath(requested: string): ParsedPath {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return { ok: false, status: 400, message: `malformed percent-encoding in "${requested}"` };
  }
  if (decoded.length === 0) {
    return { ok: false, status: 400, message: "no file was named" };
  }
  // Rejected before splitting, because a NUL can truncate a path in a syscall
  // and a backslash is a separator on the platform this may run on next.
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === "\\") {
      return { ok: false, status: 400, message: `illegal character in path "${decoded}"` };
    }
  }
  const segments = decoded.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return {
        ok: false,
        status: 403,
        message: `path "${decoded}" must be project-relative with no empty or "." segments`,
      };
    }
  }
  return { ok: true, decoded, segments };
}

/**
 * Turn the still-encoded path from a request URL into an absolute file inside
 * `root`, or a refusal.
 *
 * Read-only is not a reason to be relaxed about confinement (PLAN.md §10): a
 * loopback server that will serve any path it is handed is a file-disclosure bug
 * whether or not it can also write. Three independent checks have to agree —
 * every path segment is inspected before anything touches the filesystem, the
 * resolved path is required to sit under the root, and the *real* path is
 * required to as well so a symlink inside the project cannot point out of it.
 *
 * `requested` is the raw, percent-encoded portion of the URL after the mount
 * point, without a leading slash.
 */
export function resolveProjectAsset(root: string, requested: string): ResolvedAsset | RejectedAsset {
  const parsed = parseRelativePath(requested);
  if (!parsed.ok) return parsed;
  const { decoded, segments } = parsed;

  const contentType = contentTypeFor(decoded);
  if (contentType === undefined) {
    return {
      ok: false,
      status: 403,
      message: `"${decoded}" is not a servable project file; only ${Object.keys(SERVABLE).join(", ")} are served`,
    };
  }

  const path = resolve(root, ...segments);
  if (!isInside(root, path)) {
    return { ok: false, status: 403, message: `path "${decoded}" resolves outside the project root` };
  }

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, status: 404, message: `"${decoded}" does not exist` };
  }
  // The root is realpath'd too: on macOS the fixtures may sit under /tmp, which
  // is itself a symlink, and comparing a real path against a symlinked root
  // would reject every legitimate file.
  if (!isInside(realpathSync(root), real)) {
    return { ok: false, status: 403, message: `"${decoded}" is a link that leaves the project root` };
  }
  if (!statSync(real).isFile()) {
    return { ok: false, status: 404, message: `"${decoded}" is not a file` };
  }
  return { ok: true, path: real, contentType };
}

/** What a built single-page app is allowed to be made of. */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Resolve a file inside a built app directory, or refuse.
 *
 * The app bundle is not a project, but it is still a directory this server hands
 * out over HTTP from a path in a URL, so it gets the same treatment: segment
 * checks, an extension allowlist, and a realpath confined to the root.
 */
export function resolveStaticAsset(root: string, requested: string): ResolvedAsset | RejectedAsset {
  const parsed = parseRelativePath(requested);
  if (!parsed.ok) return parsed;
  const { decoded, segments } = parsed;

  const dot = decoded.lastIndexOf(".");
  const contentType = dot < 0 ? undefined : STATIC_TYPES[decoded.slice(dot).toLowerCase()];
  if (contentType === undefined) {
    return { ok: false, status: 403, message: `"${decoded}" is not a servable app asset` };
  }

  const path = resolve(root, ...segments);
  if (!isInside(root, path)) {
    return { ok: false, status: 403, message: `path "${decoded}" resolves outside the app root` };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, status: 404, message: `"${decoded}" does not exist` };
  }
  if (!isInside(realpathSync(root), real) || !statSync(real).isFile()) {
    return { ok: false, status: 404, message: `"${decoded}" is not a file inside the app root` };
  }
  return { ok: true, path: real, contentType };
}

/**
 * Resolve a project-relative path the UI wants to *write*, or refuse.
 *
 * Strictly narrower than the read side, and deliberately not expressed as "the
 * read allowlist, plus permission to write": PLAN.md §10 forbids a general
 * write-any-file RPC, so this accepts only the document layout of §4 — the two
 * root documents, and `<dir>/<id>.json` under the four per-object directories,
 * with `<id>` held to the format's own identifier grammar. Samples stay readable
 * and unwritable; the UI has no business replacing audio on disk.
 *
 * Confinement cannot lean on `realpathSync` of the target, because the target
 * legitimately may not exist yet. The *parent* directory is realpath'd instead —
 * that is what a symlinked `tracks/` would have to subvert — and an existing
 * target is additionally required to be a regular file that stays inside the
 * root, which is what a symlinked `tracks/kick.json` would have to subvert.
 */
export function resolveDocumentWrite(root: string, requested: string): ResolvedWrite | RejectedWrite {
  const parsed = parseRelativePath(requested);
  if (!parsed.ok) return parsed;
  const { decoded, segments } = parsed;

  const layoutError = checkDocumentLayout(decoded, segments);
  if (layoutError !== undefined) return layoutError;

  const path = resolve(root, ...segments);
  if (!isInside(root, path)) {
    return { ok: false, status: 403, message: `path "${decoded}" resolves outside the project root` };
  }

  const realRoot = realpathSync(root);
  const parent = dirname(path);
  let realParent: string | undefined;
  try {
    realParent = realpathSync(parent);
  } catch {
    realParent = undefined;
  }

  // A parent that is not there yet is only reachable for the four known document
  // directories, and only directly inside an already-confined root — the layout
  // check above admits nothing deeper. A directory that does not exist cannot be
  // a symlink pointing out of the root either, so confinement is settled by the
  // root itself and the target is named under the real root.
  if (realParent === undefined) {
    return {
      ok: true,
      path: resolve(realRoot, ...segments),
      relative: segments.join("/"),
      missingParent: parent,
    };
  }

  if (!isInside(realRoot, realParent)) {
    return { ok: false, status: 403, message: `"${decoded}" sits in a directory that links out of the project root` };
  }

  const target = `${realParent}${sep}${segments[segments.length - 1]!}`;
  let existing: ReturnType<typeof statSync> | undefined;
  try {
    existing = statSync(target);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (!existing.isFile()) {
      return { ok: false, status: 403, message: `"${decoded}" exists and is not a regular file` };
    }
    if (!isInside(realRoot, realpathSync(target))) {
      return { ok: false, status: 403, message: `"${decoded}" is a link that leaves the project root` };
    }
  }

  return { ok: true, path: target, relative: segments.join("/"), missingParent: undefined };
}

/** The §4 bundle layout, as an allowlist. Returns a refusal, or nothing. */
function checkDocumentLayout(decoded: string, segments: string[]): RejectedWrite | undefined {
  const shape = `expected project.json, arrangement.json, or <${[...DOC_DIRS].sort().join("|")}>/<id>.json`;
  if (segments.length === 1) {
    return ROOT_DOCS.has(segments[0]!)
      ? undefined
      : { ok: false, status: 403, message: `"${decoded}" is not a writable project document; ${shape}` };
  }
  if (segments.length !== 2) {
    return { ok: false, status: 403, message: `"${decoded}" is nested too deeply to be a project document; ${shape}` };
  }
  const [dir, file] = segments as [string, string];
  if (!DOC_DIRS.has(dir)) {
    return { ok: false, status: 403, message: `"${decoded}" is not in a document directory; ${shape}` };
  }
  if (!file.endsWith(".json")) {
    return { ok: false, status: 403, message: `"${decoded}" is not a .json document; ${shape}` };
  }
  const id = file.slice(0, -".json".length);
  if (!ID_PATTERN.test(id)) {
    return {
      ok: false,
      status: 403,
      message: `"${decoded}" has an id that is not a valid identifier; ids match ${ID_PATTERN.source}`,
    };
  }
  return undefined;
}

/** True when `path` is `root` itself or sits beneath it. */
function isInside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return path === base || path.startsWith(base + sep);
}
