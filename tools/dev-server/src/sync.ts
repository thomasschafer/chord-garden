import { hashContent } from "@chord-garden/engine/live";
import { loadProject } from "@chord-garden/format";
import {
  CLOSE_ALREADY_OPEN,
  CLOSE_UNAUTHORIZED,
  HELLO_TIMEOUT_MS,
  SYNC_PROTOCOL,
  type ApiDiagnostic,
  type ChangedFile,
  type ServerMessage,
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
 * `established` only advances on a snapshot that validates as a whole project, or
 * on a write. A half-finished multi-file agent edit therefore does not consume
 * the changes it contains: the UI is told the project is invalid, nothing is
 * adopted, and when the edit finishes the *whole* set of changed files arrives in
 * one snapshot. Cross-file edits reconcile atomically as a consequence rather
 * than by special-casing them (PLAN.md §12, cross-file transactions).
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
      });
    }
  }

  /** True while a browser holds this project's read-write session. */
  get hasEditor(): boolean {
    return this.editor !== undefined && this.editor.isOpen;
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
        const outcome = this.handleHello(text);
        if (outcome !== undefined) {
          this.refuse(connection, outcome.close, outcome.reason, outcome.kind);
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
        connection.startKeepalive(this.keepaliveMs);
        this.send(connection, { type: "welcome", protocol: SYNC_PROTOCOL, project: this.options.mount.name });
        this.log(`sync ${this.options.mount.name}: editor session opened`);
      },
      closed: (reason) => {
        clearTimeout(timeout);
        if (this.editor === connection) {
          this.editor = undefined;
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
      this.broadcast({
        type: "projectInvalid",
        diagnostics: [
          {
            severity: "error",
            code: "project.unreadable",
            file: "",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      return;
    }

    const diagnostics = result.diagnostics.map(toApiDiagnostic);
    if (!result.ok || result.project === undefined) {
      // Transient invalid states are expected mid-edit, so this is not an error
      // to recover from — it is a state to report and wait out. `established` is
      // untouched, so nothing here is consumed.
      this.log(`sync ${this.options.mount.name}: disk does not validate; holding the last snapshot`);
      this.broadcast({ type: "projectInvalid", diagnostics });
      return;
    }

    const changed: ChangedFile[] = [];
    const files: SnapshotFile[] = [];
    for (const file of result.files.values()) {
      const contentHash = hashContent(Buffer.from(file.text, "utf8"));
      files.push({ path: file.path, kind: file.kind, contentHash });
      if (this.established.get(file.path) !== file.text) {
        changed.push({ path: file.path, kind: file.kind, contentHash, text: file.text });
      }
    }
    const removed = [...this.established.keys()].filter((path) => !result.files.has(path)).sort();

    if (changed.length === 0 && removed.length === 0) {
      // Every byte on disk is a byte we put there or already announced: this was
      // our own echo, or an event that changed nothing.
      return;
    }

    for (const file of changed) this.established.set(file.path, file.text);
    for (const path of removed) this.established.delete(path);

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.log(
      `sync ${this.options.mount.name}: external edit — changed ${changed.map((file) => file.path).join(", ") || "none"}${
        removed.length > 0 ? `, removed ${removed.join(", ")}` : ""
      }`,
    );
    this.broadcast({ type: "projectChanged", files, changed, removed, diagnostics });
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.editor?.close(CLOSE_GOING_AWAY, "sidecar shutting down");
    this.editor = undefined;
  }

  /** What the sidecar believes is on disk. For tests and diagnostics. */
  establishedText(path: string): string | undefined {
    return this.established.get(path);
  }

  /**
   * Validate a `hello`, returning nothing when it is acceptable. Every refusal
   * names its own reason: a page that cannot connect must be able to say why.
   */
  private handleHello(text: string):
    | { close: number; reason: string; kind?: "rejected" }
    | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { close: CLOSE_PROTOCOL_ERROR, reason: `first message is not JSON: ${String(error)}` };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { close: CLOSE_PROTOCOL_ERROR, reason: "first message must be a JSON object" };
    }
    const message = parsed as Record<string, unknown>;
    if (message["type"] !== "hello") {
      return { close: CLOSE_PROTOCOL_ERROR, reason: `expected a "hello" message, got ${JSON.stringify(message["type"])}` };
    }
    if (message["protocol"] !== SYNC_PROTOCOL) {
      return {
        close: CLOSE_POLICY_VIOLATION,
        reason: `this page speaks sync protocol ${JSON.stringify(message["protocol"])} and the sidecar speaks ${SYNC_PROTOCOL}; reload the page`,
        kind: "rejected",
      };
    }
    const token = message["token"];
    if (typeof token !== "string" || !constantTimeEquals(token, this.options.token)) {
      return { close: CLOSE_UNAUTHORIZED, reason: "the session token is missing or wrong", kind: "rejected" };
    }
    if (message["project"] !== this.options.mount.name) {
      return {
        close: CLOSE_POLICY_VIOLATION,
        reason: `this socket is for project "${this.options.mount.name}", not ${JSON.stringify(message["project"])}`,
        kind: "rejected",
      };
    }
    return undefined;
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

function toApiDiagnostic(diagnostic: { severity: string; code: string; file: string; message: string }): ApiDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    file: diagnostic.file,
    message: diagnostic.message,
  };
}
