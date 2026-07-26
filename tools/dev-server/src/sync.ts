import { randomBytes } from "node:crypto";
import { hashContent } from "@chord-garden/engine/live";
import { loadProject } from "@chord-garden/format";
import {
  CLOSE_ALREADY_OPEN,
  CLOSE_UNAUTHORIZED,
  HELLO_TIMEOUT_MS,
  inventoryHash,
  SYNC_PROTOCOL,
  type ApiDiagnostic,
  type HelloMessage,
  type ServerMessage,
  type SnapshotDocument,
  type SnapshotFile,
} from "./api.js";
import type { ProjectMount } from "./server.js";
import { constantTimeEquals } from "./token.js";
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY_VIOLATION,
  CLOSE_PROTOCOL_ERROR,
  type WebSocketConnection,
} from "./websocket.js";
import { DirectoryWatcher } from "./watch.js";

/** How often an authenticated socket is pinged, and how long a pong may take. */
export const KEEPALIVE_MS = 15_000;

export interface ProjectSyncOptions {
  mount: ProjectMount;
  /** The session token, required in the socket's first message. */
  token: string;
  settleMs?: number;
  maxSettleMs?: number;
  /** How often the watcher re-scans an idle project (see `IDLE_RESCAN_MS`). */
  rescanMs?: number;
  keepaliveMs?: number;
  /** How long an unauthenticated socket may stay silent. */
  helloTimeoutMs?: number;
  /**
   * Whether to run a real filesystem watcher. Off in tests that drive `scan()`
   * directly, so a test asserting *what* a scan concludes is not also waiting on
   * the OS to decide *when* it happens.
   */
  watchFilesystem?: boolean;
  log?: (line: string) => void;
}

/**
 * The watcher, echo detection, and the browser's push channel for one project.
 *
 * ## Echo detection (PLAN.md §12 step 3, §18's linchpin)
 *
 * This holds `established`: the exact bytes of every document as this sidecar
 * last *established* them, meaning either it wrote them itself on the UI's
 * behalf, or it has already told the UI about them. A settle scan reads the
 * project and compares. Bytes that match what was established are, by
 * definition, bytes the UI already has — its own write coming back, a `touch`, an
 * editor rewriting a file unchanged — so nothing is pushed. Bytes that differ are
 * an external edit, and are pushed.
 *
 * The thing this deliberately does *not* do is suppress events for a period after
 * a write. That is the tempting implementation and it is the one that loses an
 * agent's work: an agent edit landing in the same window as a UI write would be
 * mistaken for the echo of that write and silently dropped, with the UI then
 * overwriting it at the next keystroke. Time never enters the decision here —
 * only content does, so "someone changed this file to something other than what
 * we put there" is answered correctly no matter when it happened.
 *
 * The comparison is over full bytes rather than the content hash. The hash is
 * still what travels to the browser (it is what write preconditions are made of),
 * but the sidecar has both strings in memory, and an identity decision that can
 * silently lose an edit on a hash collision is not worth the microseconds.
 *
 * ## Validity
 *
 * `established` only advances on a snapshot that validates as a whole project, on
 * a write, or on a snapshot served over HTTP to the session holder. A half-finished
 * multi-file agent edit therefore does not consume the changes it contains: the UI
 * is told the project is invalid, nothing is adopted, and when the edit finishes
 * the *whole* set of changed files arrives in one snapshot. Cross-file edits
 * reconcile atomically as a consequence rather than by special-casing them
 * (PLAN.md §12, cross-file transactions).
 *
 * ## Deletion and recreation
 *
 * Nothing here tracks a file's *existence* over time, and that is the whole
 * answer to delete/recreate — an agent moving a file, or a tool that writes by
 * unlinking and creating rather than renaming. A file that vanishes and comes back
 * with the same bytes inside one settle window is a non-event, because the bytes on
 * disk when the dust settles are the bytes already established; one that comes
 * back different is an ordinary external edit; one that is still gone is a removal.
 * Existence is just another thing the settled disk is asked about, so there is no
 * event sequence to get wrong.
 *
 * The one case that needs its own state is a delete whose *intermediate* state was
 * reported. A removal that makes the project invalid — deleting a pattern a clip
 * plays — is reported as any other invalid state is: keep the last good model, show
 * diagnostics, adopt nothing. If the file then returns byte-identical, the disk now
 * matches `established` exactly, so a purely content-based diff would say nothing
 * and leave the UI insisting the project is broken forever. So a snapshot that
 * validates after an invalid one was reported is always announced, even when it
 * carries no changed files: the announcement is what retracts the diagnostics.
 */
export class ProjectSync {
  private readonly established = new Map<string, string>();
  private readonly watcher: DirectoryWatcher | undefined;
  private readonly keepaliveMs: number;
  private readonly log: (line: string) => void;
  /**
   * The one read-write session (PLAN.md §12, single-writer). Held rather than a
   * set: a second editing browser is refused, not queued.
   */
  private editor: WebSocketConnection | undefined;
  /** The write credential of the current session, minted when it is admitted. */
  private session: string | undefined;
  /**
   * Whether the last thing said about the disk was "it does not validate". While
   * it is set, the next validating snapshot is announced even if it changed
   * nothing, so a retracted invalid state cannot stay on screen.
   */
  private reportedInvalid = false;
  /**
   * Set when the current session asked to be caught up — it arrived holding an
   * inventory that is not the one established here — and has not been. The next
   * validating snapshot is then sent in full rather than as a diff. Retained
   * across invalid states so that a reconnect landing mid-edit still gets its
   * catch-up when the edit finishes, rather than a diff against a state it never
   * had.
   */
  private owedFullSnapshot = false;
  private closed = false;

  constructor(private readonly options: ProjectSyncOptions) {
    this.log = options.log ?? (() => {});
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    this.seed();
    if (options.watchFilesystem ?? true) {
      this.watcher = new DirectoryWatcher({
        root: options.mount.root,
        onSettle: () => this.scan(),
        onError: (message) => this.log(`watch ${options.mount.name}: ${message}`),
        ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
        ...(options.maxSettleMs === undefined ? {} : { maxSettleMs: options.maxSettleMs }),
        ...(options.rescanMs === undefined ? {} : { rescanMs: options.rescanMs }),
      });
    }
  }

  /** True while a browser holds this project's read-write session. */
  get hasEditor(): boolean {
    return this.editor !== undefined && this.editor.isOpen;
  }

  /**
   * Whether `session` is the credential of the browser that currently holds this
   * project's read-write session (PLAN.md §12).
   *
   * The write endpoint asks this before it touches the disk. Without it,
   * single-writer is enforced only at the socket, and a window that was *told* the
   * project is open elsewhere can still POST a write: refusing the socket takes
   * away the pushes, not the writing. Constant-time because it costs nothing.
   */
  holdsSession(session: string): boolean {
    return this.hasEditor && this.session !== undefined && constantTimeEquals(session, this.session);
  }

  /**
   * Take over a freshly upgraded socket.
   *
   * Nothing is trusted yet: the socket is unauthenticated, and stays that way
   * until a well-formed `hello` carrying the session token arrives inside
   * `HELLO_TIMEOUT_MS` (PLAN.md §10 — first-message authentication, so the token
   * never appears in a URL). Any other message, before or after the handshake,
   * closes the socket.
   */
  attach(connection: WebSocketConnection): void {
    let authenticated = false;
    const timeout = setTimeout(
      () => {
        if (!authenticated) connection.close(CLOSE_POLICY_VIOLATION, "no hello message; closing");
      },
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );
    timeout.unref();

    connection.on({
      message: (text) => {
        if (authenticated) {
          // The protocol is one-way after the handshake. An unknown message type
          // is refused rather than ignored (PLAN.md §10).
          this.refuse(connection, CLOSE_PROTOCOL_ERROR, "this protocol accepts no messages after \"hello\"");
          return;
        }
        const outcome = this.readHello(text);
        if ("refusal" in outcome) {
          this.refuse(connection, outcome.refusal.close, outcome.refusal.reason, outcome.refusal.kind);
          return;
        }
        if (this.hasEditor) {
          // PLAN.md §12: one read-write UI session per project. The second
          // browser is told why rather than silently made a spectator.
          this.refuse(
            connection,
            CLOSE_ALREADY_OPEN,
            `project "${this.options.mount.name}" is open in another window`,
            "rejected",
          );
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        this.editor = connection;
        this.session = randomBytes(16).toString("hex");
        connection.startKeepalive(this.keepaliveMs);
        this.send(connection, {
          type: "welcome",
          protocol: SYNC_PROTOCOL,
          project: this.options.mount.name,
          session: this.session,
        });
        this.log(`sync ${this.options.mount.name}: editor session opened`);
        this.catchUp(outcome.hello.inventory);
      },
      closed: (reason) => {
        clearTimeout(timeout);
        if (this.editor === connection) {
          this.editor = undefined;
          this.session = undefined;
          // Whatever this session was owed dies with it: the next one states what
          // it holds in its own hello.
          this.owedFullSnapshot = false;
          this.log(`sync ${this.options.mount.name}: editor session ended (${reason})`);
        }
      },
    });
  }

  /**
   * Record bytes this sidecar just wrote, so the watcher recognises the echo.
   *
   * Must be called in the same synchronous block as the write itself — which is
   * why `writeBatch` calls it rather than the route handler. A filesystem event
   * cannot be delivered mid-block, so there is no window in which the watcher
   * could scan a file this server has written but not yet established.
   */
  noteWrite(path: string, contents: string): void {
    this.established.set(path, contents);
  }

  /**
   * Record bytes this sidecar just served to the session holder as a whole-project
   * snapshot, for the same reason `noteWrite` records bytes it wrote: the browser
   * now has them, so re-announcing them would be a push with nothing in it.
   *
   * Only ever called for the holder of the read-write session, and only for a
   * snapshot that validated. A snapshot served to anything else — the engine
   * harness, a second window that was refused, `curl` — must not advance this, or
   * that read would swallow the editor's next push and lose an agent's edit.
   *
   * Synchronous with the response for the same reason as `noteWrite`: no
   * filesystem event can be delivered mid-block, so there is no window in which a
   * scan could see bytes that were served but not yet established.
   */
  noteServed(documents: readonly { path: string; text: string }[]): void {
    this.established.clear();
    for (const document of documents) this.established.set(document.path, document.text);
    // The holder has just read the whole project from disk, so it is caught up by
    // definition and nothing about an earlier invalid state is still on its screen.
    this.owedFullSnapshot = false;
    this.reportedInvalid = false;
  }

  /**
   * Deliver what a reconnecting page missed (PLAN.md §12).
   *
   * `inventory` is what the page says it holds. A page with nothing sends none, and
   * loads over HTTP instead. A page whose inventory is the one established here
   * missed nothing while it was away — the sidecar announces differences from what
   * it established, and that is what this page has. Anything else means the disk
   * moved without this page hearing about it, and only a full snapshot can say how:
   * the sidecar keeps no history, and a diff against a state the page never had is
   * how a browser ends up holding a model that never existed on disk.
   */
  private catchUp(inventory: string | undefined): void {
    if (inventory === undefined) return;
    if (inventory === this.establishedInventory()) {
      this.log(`sync ${this.options.mount.name}: session reconnected in step with the disk`);
      return;
    }
    this.log(`sync ${this.options.mount.name}: session reconnected behind the disk; sending a full snapshot`);
    this.owedFullSnapshot = true;
    // Sent now if the disk validates; if it does not, the flag keeps it owed and
    // the next validating scan pays it.
    this.scan();
  }

  /** The inventory hash of what this sidecar has established, for `catchUp`. */
  private establishedInventory(): string {
    return inventoryHash(
      [...this.established].map(([path, text]) => ({ path, contentHash: hashContent(Buffer.from(text, "utf8")) })),
    );
  }

  /**
   * Read the project, decide what changed, and push it. Called by the watcher
   * after a settle window, and directly by tests.
   */
  scan(): void {
    if (this.closed) return;
    let result: ReturnType<typeof loadProject>;
    try {
      result = loadProject(this.options.mount.root);
    } catch (error) {
      // A project directory that cannot be read at all is not a state to guess
      // about; it is reported and the last good model stays where it is.
      this.reportInvalid([
        {
          severity: "error",
          code: "project.unreadable",
          file: "",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
      return;
    }

    const diagnostics = result.diagnostics.map(toApiDiagnostic);
    if (!result.ok || result.project === undefined) {
      // Transient invalid states are expected mid-edit, so this is not an error
      // to recover from — it is a state to report and wait out. `established` is
      // untouched, so nothing here is consumed. This is also where a deletion that
      // breaks the project lands, which is why nothing below it treats a missing
      // file as a special case.
      this.log(`sync ${this.options.mount.name}: disk does not validate; holding the last snapshot`);
      this.reportInvalid(diagnostics);
      return;
    }

    const full = this.owedFullSnapshot;
    const changed: SnapshotDocument[] = [];
    const files: SnapshotFile[] = [];
    for (const file of result.files.values()) {
      const contentHash = hashContent(Buffer.from(file.text, "utf8"));
      files.push({ path: file.path, kind: file.kind, contentHash });
      if (full || this.established.get(file.path) !== file.text) {
        changed.push({ path: file.path, kind: file.kind, contentHash, text: file.text });
      }
    }
    const removed = [...this.established.keys()].filter((path) => !result.files.has(path)).sort();

    if (!full && !this.reportedInvalid && changed.length === 0 && removed.length === 0) {
      // Every byte on disk is a byte we put there or already announced, and every
      // document we knew about is still there: this was our own echo, an event that
      // changed nothing, or a file that vanished and came back unchanged.
      return;
    }

    for (const file of changed) this.established.set(file.path, file.text);
    for (const path of removed) this.established.delete(path);

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.log(
      `sync ${this.options.mount.name}: ${full ? "full snapshot" : "external edit"} — changed ${
        changed.map((file) => file.path).join(", ") || "none"
      }${removed.length > 0 ? `, removed ${removed.join(", ")}` : ""}`,
    );
    this.reportedInvalid = false;
    this.owedFullSnapshot = false;
    this.broadcast({ type: "projectChanged", scope: full ? "full" : "diff", files, changed, removed, diagnostics });
  }

  /**
   * Say that the disk does not currently validate, and remember having said it.
   *
   * The remembering is what makes a retraction possible: if the disk returns to
   * exactly the bytes already established — a delete-then-recreate, a broken edit
   * reverted — there is no content difference left to report, and without this flag
   * the UI would keep showing an error about a state that no longer exists.
   */
  private reportInvalid(diagnostics: ApiDiagnostic[]): void {
    this.reportedInvalid = true;
    this.broadcast({ type: "projectInvalid", diagnostics });
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.editor?.close(CLOSE_GOING_AWAY, "sidecar shutting down");
    this.editor = undefined;
    this.session = undefined;
  }

  /** What the sidecar believes is on disk. For tests and diagnostics. */
  establishedText(path: string): string | undefined {
    return this.established.get(path);
  }

  /**
   * Validate a `hello`, returning the message itself when it is acceptable. Every
   * refusal names its own reason: a page that cannot connect must be able to say why.
   */
  private readHello(text: string): { hello: HelloMessage } | { refusal: Refusal } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { refusal: { close: CLOSE_PROTOCOL_ERROR, reason: `first message is not JSON: ${String(error)}` } };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { refusal: { close: CLOSE_PROTOCOL_ERROR, reason: "first message must be a JSON object" } };
    }
    const message = parsed as Record<string, unknown>;
    if (message["type"] !== "hello") {
      return {
        refusal: {
          close: CLOSE_PROTOCOL_ERROR,
          reason: `expected a "hello" message, got ${JSON.stringify(message["type"])}`,
        },
      };
    }
    if (message["protocol"] !== SYNC_PROTOCOL) {
      return {
        refusal: {
          close: CLOSE_POLICY_VIOLATION,
          reason: `this page speaks sync protocol ${JSON.stringify(message["protocol"])} and the sidecar speaks ${SYNC_PROTOCOL}; reload the page`,
          kind: "rejected",
        },
      };
    }
    const token = message["token"];
    if (typeof token !== "string" || !constantTimeEquals(token, this.options.token)) {
      return {
        refusal: { close: CLOSE_UNAUTHORIZED, reason: "the session token is missing or wrong", kind: "rejected" },
      };
    }
    const project = message["project"];
    if (project !== this.options.mount.name) {
      return {
        refusal: {
          close: CLOSE_POLICY_VIOLATION,
          reason: `this socket is for project "${this.options.mount.name}", not ${JSON.stringify(project)}`,
          kind: "rejected",
        },
      };
    }
    const inventory = message["inventory"];
    if (inventory !== undefined && typeof inventory !== "string") {
      return {
        refusal: {
          close: CLOSE_PROTOCOL_ERROR,
          reason: `"inventory" must be a string if present, got ${JSON.stringify(inventory)}`,
        },
      };
    }
    return {
      hello: {
        type: "hello",
        protocol: SYNC_PROTOCOL,
        token,
        project,
        ...(inventory === undefined ? {} : { inventory }),
      },
    };
  }

  private refuse(
    connection: WebSocketConnection,
    close: number,
    reason: string,
    kind: "rejected" | "error" = "error",
  ): void {
    this.log(`sync ${this.options.mount.name}: refusing socket — ${reason}`);
    this.send(connection, kind === "rejected" ? { type: "rejected", reason } : { type: "error", message: reason });
    connection.close(close, reason);
  }

  private broadcast(message: ServerMessage): void {
    if (this.editor === undefined || !this.editor.isOpen) return;
    this.send(this.editor, message);
  }

  private send(connection: WebSocketConnection, message: ServerMessage): void {
    connection.sendText(JSON.stringify(message));
  }

  /**
   * Establish the project's current state at startup, so the first external edit
   * is reported as a diff rather than as "every file changed".
   *
   * An invalid project is left unestablished on purpose: there is no valid
   * snapshot to be the baseline, and the browser's own per-file check makes the
   * resulting first full announcement harmless.
   */
  private seed(): void {
    try {
      const result = loadProject(this.options.mount.root);
      if (!result.ok) {
        this.log(`sync ${this.options.mount.name}: project does not validate at startup; watching anyway`);
        return;
      }
      for (const file of result.files.values()) this.established.set(file.path, file.text);
    } catch (error) {
      this.log(`sync ${this.options.mount.name}: could not read the project at startup: ${String(error)}`);
    }
  }
}

/** Why a socket is being closed, and what to tell it first. */
interface Refusal {
  close: number;
  reason: string;
  kind?: "rejected";
}

function toApiDiagnostic(diagnostic: { severity: string; code: string; file: string; message: string }): ApiDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    file: diagnostic.file,
    message: diagnostic.message,
  };
}
