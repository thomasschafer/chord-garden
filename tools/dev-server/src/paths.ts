import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

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

export type ResolvedAsset = { ok: true; path: string; contentType: string };
export type RejectedAsset = { ok: false; status: 400 | 403 | 404; message: string };

/** Media type for a project-relative path, or undefined if it is not servable. */
export function contentTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : SERVABLE[path.slice(dot).toLowerCase()];
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
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) {
    return { ok: false, status: 400, message: `illegal character in path "${decoded}"` };
  }
  const segments = decoded.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, status: 403, message: `path "${decoded}" must be project-relative with no empty or "." segments` };
    }
  }

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

/** True when `path` is `root` itself or sits beneath it. */
function isInside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return path === base || path.startsWith(base + sep);
}
