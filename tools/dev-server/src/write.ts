import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hashContent } from "@chord-garden/engine/live";
import { docKindFromHint, docKindHintForPath, parseStrictJson, serializeCanonical } from "@chord-garden/format/pure";
import { WRITE_CONFLICT_STATUS, type WriteAck, type WriteDeleteFile, type WriteRequestFile } from "./api.js";
import { resolveDocumentWrite } from "./paths.js";

/** One batch may not exceed this many bytes of JSON body. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** No project of this format has anything like this many documents. */
export const MAX_BATCH_FILES = 64;
/** A single canonical document past this size is a bug, not a song. */
export const MAX_FILE_BYTES = 512 * 1024;

export type WriteBatchResult =
  | { ok: true; acks: WriteAck[]; removed: string[] }
  | { ok: false; status: 400 | 403 | 409 | 422; message: string };

/**
 * What the sidecar wants to know about a batch as it lands, in the same
 * synchronous block as the filesystem call. Grouped into one object rather than
 * two positional callbacks because forgetting to pass the second one would make
 * the watcher announce the UI's own deletion back to it as an external change.
 */
export interface WriteBatchObserver {
  written?: (path: string, contents: string) => void;
  removed?: (path: string) => void;
}

/**
 * Content hash of a document as it currently sits on disk, or `null` when there
 * is no such file. The same function the caller hashes its own expectation with,
 * so the two sides cannot disagree about what a hash of these bytes is.
 */
export function hashOnDisk(path: string): string | null {
  try {
    return hashContent(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Validate and atomically persist a batch of project documents.
 *
 * Every file is checked before any file is written, because a batch that fails
 * halfway leaves the project in a state neither the UI nor the agent asked for.
 * Within the batch each file lands atomically (temp file inside the project,
 * fsync, rename), so a watcher never observes a torn document (PLAN.md §10, §12).
 *
 * Two content rules are enforced here rather than trusted to the client:
 *
 * - The body must parse under the format's own strict JSON reader, so a writer
 *   cannot introduce a comment or a duplicate key that `loadProject` would then
 *   refuse to read back.
 * - The bytes must already be canonical. This is the boundary version of PLAN.md
 *   §3's rule that the UI is one editor among two: a client that grew its own
 *   serializer would produce files `musictool fmt` disagrees with, and that
 *   divergence is exactly what this project spends its effort eliminating. It is
 *   cheaper to reject the write than to discover the drift in a diff later.
 *
 * Schema and semantic validity are deliberately *not* required: PLAN.md §12 wants
 * transient invalid states to be tolerated, and the caller re-validates the
 * project after the batch lands to surface diagnostics.
 *
 * Finally, every file carries a precondition: the hash the caller believes is on
 * disk. Any mismatch refuses the whole batch with 409 and writes nothing. Until
 * the Phase 4 watcher exists, this is what stops an editor that has been open
 * across someone else's edit from silently overwriting it — the failure mode
 * PLAN.md §3 least tolerates, because it makes the two editors unequal.
 */
export function writeBatch(
  root: string,
  files: readonly WriteRequestFile[],
  observer: WriteBatchObserver = {},
  deletes: readonly WriteDeleteFile[] = [],
): WriteBatchResult {
  if (files.length === 0 && deletes.length === 0) {
    return { ok: false, status: 400, message: "write batch contained no files" };
  }
  if (files.length + deletes.length > MAX_BATCH_FILES) {
    return {
      ok: false,
      status: 400,
      message: `write batch has ${files.length + deletes.length} files, more than the limit of ${MAX_BATCH_FILES}`,
    };
  }

  const planned: { target: string; relative: string; contents: string; expectedHash: string | null; hash: string }[] = [];
  const removals: { target: string; relative: string; expectedHash: string }[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (typeof file.path !== "string" || typeof file.contents !== "string") {
      return { ok: false, status: 400, message: "every write batch entry needs a string \"path\" and string \"contents\"" };
    }
    const bytes = Buffer.byteLength(file.contents, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, status: 400, message: `"${file.path}" is ${bytes} bytes, more than the ${MAX_FILE_BYTES}-byte limit for one document` };
    }

    const resolved = resolveDocumentWrite(root, file.path);
    if (!resolved.ok) return resolved;
    if (seen.has(resolved.relative)) {
      return { ok: false, status: 400, message: `"${resolved.relative}" appears twice in one write batch` };
    }
    seen.add(resolved.relative);

    const canonical = checkCanonical(resolved.relative, file.contents);
    if (canonical !== undefined) return canonical;

    if (file.expectedHash !== null && typeof file.expectedHash !== "string") {
      return {
        ok: false,
        status: 400,
        message: `"${resolved.relative}" has no "expectedHash"; every write must say what it believes is on disk`,
      };
    }

    planned.push({
      target: resolved.path,
      relative: resolved.relative,
      contents: file.contents,
      expectedHash: file.expectedHash,
      hash: hashContent(Buffer.from(file.contents, "utf8")),
    });
  }

  for (const file of deletes) {
    if (typeof file.path !== "string") {
      return { ok: false, status: 400, message: 'every write batch deletion needs a string "path"' };
    }
    if (typeof file.expectedHash !== "string") {
      return {
        ok: false,
        status: 400,
        message: `"${file.path}" has no "expectedHash"; a deletion must say which bytes it believes it is removing`,
      };
    }
    const resolved = resolveDocumentWrite(root, file.path);
    if (!resolved.ok) return resolved;
    if (seen.has(resolved.relative)) {
      return { ok: false, status: 400, message: `"${resolved.relative}" appears twice in one write batch` };
    }
    seen.add(resolved.relative);
    removals.push({ target: resolved.path, relative: resolved.relative, expectedHash: file.expectedHash });
  }

  // Preconditions are checked for the whole batch before a single file is
  // written, so a conflict on the last file cannot leave the first one applied.
  // Deletions are in the same pass: a removal whose file has already changed is
  // exactly as much of a lost update as an overwrite would be.
  const conflicts = [...planned, ...removals]
    .filter((entry) => hashOnDisk(entry.target) !== entry.expectedHash)
    .map((entry) => entry.relative);
  if (conflicts.length > 0) {
    return {
      ok: false,
      status: WRITE_CONFLICT_STATUS,
      message: `${conflicts.join(", ")} changed on disk since this editor last read ${conflicts.length === 1 ? "it" : "them"}; nothing was written. Reload the project to pick up the change.`,
    };
  }

  const acks: WriteAck[] = [];
  for (const entry of planned) {
    writeFileAtomically(entry.target, entry.contents);
    // Reported here, inside the same synchronous block as the write, rather than
    // by the caller afterwards. The watcher's echo detection depends on knowing
    // these bytes before it can possibly scan them, and "the caller remembers to
    // tell the watcher" is exactly the kind of ordering assumption that decays
    // into an infinite write/watch loop (PLAN.md §18).
    observer.written?.(entry.relative, entry.contents);
    acks.push({ path: entry.relative, bytes: Buffer.byteLength(entry.contents, "utf8"), contentHash: entry.hash });
  }
  const removed: string[] = [];
  for (const entry of removals) {
    unlinkSync(entry.target);
    // The mirror of `written`, and for the same reason: a removal the sidecar has
    // not been told about is one its next scan reads as an external deletion and
    // announces back to the window that asked for it.
    observer.removed?.(entry.relative);
    removed.push(entry.relative);
  }
  return { ok: true, acks, removed };
}

/** Refuse anything that is not the canonical serialization of its own content. */
function checkCanonical(relative: string, contents: string): { ok: false; status: 422; message: string } | undefined {
  const hint = docKindHintForPath(relative);
  if (hint === undefined) {
    // Unreachable via `resolveDocumentWrite`, which allows only layout paths.
    return { ok: false, status: 422, message: `"${relative}" is not a recognised document path` };
  }
  const parsed = parseStrictJson(contents, relative);
  if (parsed.value === undefined) {
    const why = parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
    return { ok: false, status: 422, message: `"${relative}" is not strict JSON: ${why}` };
  }
  const kind = docKindFromHint(hint, parsed.value);
  if (kind === undefined) {
    return {
      ok: false,
      status: 422,
      message: `"${relative}" does not say which kind of document it is; a pattern needs "kind" and an instrument needs "type"`,
    };
  }
  let canonical: string;
  try {
    canonical = serializeCanonical(parsed.value, kind);
  } catch (error) {
    return { ok: false, status: 422, message: `"${relative}" cannot be serialized canonically: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (canonical !== contents) {
    return {
      ok: false,
      status: 422,
      message: `"${relative}" is not canonical bytes; every writer must emit exactly what \`musictool fmt\` would (PLAN.md §3)`,
    };
  }
  return undefined;
}

/**
 * Write `contents` to `target` so that a reader sees either the old file or the
 * whole new one. The temp file is a dotted name in the same directory: same
 * filesystem so the rename is atomic, dotted so the loader's directory scan
 * ignores it rather than warning about an unexpected file.
 */
function writeFileAtomically(target: string, contents: string): void {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, contents, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; the original error is the
      // one worth reporting.
    }
    throw error;
  }
}
