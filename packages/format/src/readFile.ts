import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";

/**
 * Why a path could not be read as a regular file of an acceptable size.
 *
 * Modelled as data rather than thrown, because every caller here turns it into a
 * `Diagnostic` with its own code and pointer, and a project that contains one bad
 * path should still report everything else wrong with it.
 */
export type ReadRefusal =
  | { reason: "missing" }
  /** `description` names the kind of thing found, for the diagnostic message. */
  | { reason: "not-regular"; description: string }
  | { reason: "too-large"; size: number };

export type ReadOutcome = { ok: true; bytes: Buffer } | { ok: false; refusal: ReadRefusal };

/**
 * `O_NONBLOCK` is the difference between a diagnostic and a hang.
 *
 * Opening a FIFO read-only blocks until something opens the write end, which for
 * a stray `mkfifo` in a project directory is never — and because these reads are
 * synchronous, that blocks the whole event loop, taking the dev server's other
 * requests and its watcher down with it. The flag makes the open return
 * immediately so `fstat` can see what it is and refuse.
 *
 * It has no effect on reads from a regular file, which is the only kind this
 * agrees to read. Windows has no `O_NONBLOCK` and Node leaves it undefined there
 * despite the type, so it is defaulted rather than assumed.
 */
const READ_FLAGS = constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0);

function describeFileType(stat: Stats): string {
  if (stat.isDirectory()) return "a directory";
  if (stat.isFIFO()) return "a FIFO (named pipe)";
  if (stat.isSocket()) return "a socket";
  if (stat.isCharacterDevice()) return "a character device";
  if (stat.isBlockDevice()) return "a block device";
  if (stat.isSymbolicLink()) return "a symbolic link";
  return "not a regular file";
}

/**
 * Read a whole file, refusing anything that is not a regular file within
 * `maxBytes`.
 *
 * One `open` decides existence, permission and file type, and the `fstat` that
 * classifies the file is taken on that same descriptor, so there is no window in
 * which the thing checked and the thing read could differ.
 */
export function readRegularFile(path: string, maxBytes: number): ReadOutcome {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return { ok: false, refusal: { reason: "missing" } };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, refusal: { reason: "not-regular", description: describeFileType(stat) } };
    }
    if (stat.size > maxBytes) {
      return { ok: false, refusal: { reason: "too-large", size: stat.size } };
    }
    return { ok: true, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}
