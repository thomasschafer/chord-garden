import { watch, type FSWatcher } from "node:fs";
import { docKindHintForPath } from "@chord-garden/format/pure";

/** Settle window for filesystem events (PLAN.md §12 step 3). */
export const SETTLE_MS = 100;

/**
 * Longest a continuous stream of events may postpone a scan.
 *
 * Without it the settle timer can be restarted forever — a `musictool render`
 * writing a WAV into the project, an agent rewriting a file in a loop — and the
 * UI would never hear about anything. This bounds the delay: events keep
 * coalescing, but a scan happens at least this often while they arrive.
 */
export const MAX_SETTLE_MS = 500;

/**
 * How often an idle project is re-scanned even though no event arrived.
 *
 * A safety net, not the primary path. Recursive `fs.watch` is not uniformly
 * reliable: on Linux it is emulated by walking the tree, so a subdirectory created
 * and populated quickly can be missed entirely, and on a network mount there may be
 * no events at all. Both failures are silent — the UI simply stops following the
 * disk — and both are cured by asking the disk again occasionally, because the scan
 * this triggers reads and diffs the whole project rather than trusting an event.
 *
 * Slow on purpose: an event-driven scan is ~100 ms away, so this only has to bound
 * how long a *missed* event can hide. Idle re-scans are also nearly free — a
 * project's documents are a few kilobytes, and a scan that finds nothing new pushes
 * nothing.
 */
export const IDLE_RESCAN_MS = 5_000;

export interface DirectoryWatcherOptions {
  root: string;
  /** Called once per settled burst, never concurrently with itself. */
  onSettle: () => void;
  onError: (message: string) => void;
  settleMs?: number;
  maxSettleMs?: number;
  rescanMs?: number;
}

/**
 * Watch a project directory and report *that* something settled, not what.
 *
 * The deliberate narrowness is the point. Filesystem events are the least
 * trustworthy input in this system — coalesced by the OS, sometimes missing a
 * filename, sometimes reporting a directory instead of the file, and always
 * capable of arriving while a file is half-written — so nothing downstream is
 * allowed to depend on their content. This watcher's only job is to decide
 * *when* the dust has settled; the sync layer then reads the project from disk
 * and diffs it, which is a question the filesystem answers reliably.
 *
 * Events are filtered only where the filter is safe: a path that cannot be a
 * project document (a `render/` WAV, an editor swap file, one of this server's
 * own `.tmp` files) is ignored, and a nameless event is *not*, because "we do
 * not know what changed" must mean "look", not "assume nothing".
 *
 * Because events are untrustworthy in the other direction too — some never arrive —
 * an idle project is also re-scanned every `IDLE_RESCAN_MS` (see the constant).
 */
export class DirectoryWatcher {
  private readonly watcher: FSWatcher;
  private readonly settleMs: number;
  private readonly maxSettleMs: number;
  private readonly rescanMs: number;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the burst currently coalescing began, for the max-delay bound. */
  private burstStartedAt = 0;
  private closed = false;

  constructor(private readonly options: DirectoryWatcherOptions) {
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.maxSettleMs = options.maxSettleMs ?? MAX_SETTLE_MS;
    this.rescanMs = options.rescanMs ?? IDLE_RESCAN_MS;
    this.armRescan();
    this.watcher = watch(options.root, { recursive: true, persistent: true });
    this.watcher.on("change", (_event, filename) => {
      this.touch(typeof filename === "string" ? filename : filename?.toString("utf8"));
    });
    this.watcher.on("error", (error: Error) => {
      options.onError(`watching ${options.root} failed: ${error.message}`);
    });
  }

  /** Note an event and (re)arm the settle timer. Exposed for tests. */
  touch(filename: string | undefined): void {
    if (this.closed) return;
    if (filename !== undefined && !couldBeDocument(filename)) return;

    const now = Date.now();
    if (this.timer === undefined) {
      this.burstStartedAt = now;
    } else {
      clearTimeout(this.timer);
      if (now - this.burstStartedAt >= this.maxSettleMs) {
        this.timer = undefined;
        this.fire();
        return;
      }
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, this.settleMs);
  }

  /** True while a burst is still coalescing. */
  get settling(): boolean {
    return this.timer !== undefined;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.rescanTimer !== undefined) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    this.watcher.close();
  }

  /**
   * Arm the idle safety net for `rescanMs` from now.
   *
   * Re-armed by every scan, whatever caused it, so the rule is simply "a scan
   * happens at most `rescanMs` after the last one". A repeating interval would
   * instead skip a tick that landed just after an event-driven scan and leave a gap
   * of nearly twice the interval, which is a worse guarantee for no benefit.
   */
  private armRescan(): void {
    if (this.rescanTimer !== undefined) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      // A burst that is still coalescing is about to scan on its own; reading the
      // disk twice for the same news is exactly what the settle window prevents.
      if (this.timer === undefined) this.fire();
      else this.armRescan();
    }, this.rescanMs);
    this.rescanTimer.unref();
  }

  private fire(): void {
    if (this.closed) return;
    this.armRescan();
    try {
      this.options.onSettle();
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Could a filesystem event about this name concern a project document?
 *
 * Answers only for names, and answers conservatively: the §4 layout is the
 * allowlist, so `patterns/x.json` counts and `render/master.wav`,
 * `patterns/.x.json.1234.tmp` and `samples/kick.wav` do not.
 *
 * Samples are excluded on purpose. Replacing one changes what the project
 * *sounds* like without changing any document, which the v1 reconcile has no way
 * to express — the live engine's sample cache is keyed by content and invalidated
 * on load (Phase 2). Making that live is real work, not a filter change, so it
 * stays out rather than half-arriving here.
 */
export function couldBeDocument(filename: string): boolean {
  const path = filename.replaceAll("\\", "/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return false;
  return docKindHintForPath(path) !== undefined;
}
